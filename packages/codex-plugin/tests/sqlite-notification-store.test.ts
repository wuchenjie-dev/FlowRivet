import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { WorkItemNotificationCandidate } from "../src/notifications/notification-diff-engine.js";
import { SqliteNotificationStore } from "../src/notifications/sqlite-notification-store.js";

const now = new Date("2026-08-12T00:00:00.000Z");
const account = { providerId: "feishu-project", accountKey: "user-one" };

function store(platform: NodeJS.Platform = process.platform) {
  const directory = mkdtempSync(join(tmpdir(), "flowrivet-notifications-"));
  const path = join(directory, "notifications.db");
  return { path, value: new SqliteNotificationStore({ path, DatabaseSync, platform }) };
}

function baseline(key = "item:1") {
  return [{
    workItemKey: key,
    title: `Title ${key}`,
    projectName: "Project",
    stage: "todo" as const,
    providerStatus: "planning",
    observedAt: now.toISOString(),
  }];
}

function event(overrides: Partial<WorkItemNotificationCandidate> = {}): WorkItemNotificationCandidate {
  return {
    providerId: "feishu-project",
    workItemKey: "item:1",
    type: "assigned",
    title: "Title item:1",
    projectName: "Project",
    message: "新任务已分配给你",
    occurredAt: now.toISOString(),
    externalUrl: "https://project.feishu.cn/space/story/detail/1",
    dedupeMaterial: "item:1\0assigned\0new",
    ...overrides,
  };
}

describe("SQLite notification store", () => {
  it("distinguishes an absent baseline from an established empty baseline", async () => {
    const { value } = store();

    await expect(value.loadBaseline(account)).resolves.toBeUndefined();
    await value.applyScan({ account, baseline: [], events: [], now });
    await expect(value.loadBaseline(account)).resolves.toEqual([]);
  });

  it("atomically replaces the baseline and inserts deduplicated events", async () => {
    const { value } = store();

    const first = await value.applyScan({
      account,
      baseline: baseline(),
      events: [event()],
      now,
    });
    const repeated = await value.applyScan({
      account,
      baseline: baseline("item:2"),
      events: [event()],
      now: new Date("2026-08-12T00:01:00.000Z"),
    });

    expect(first).toHaveLength(1);
    expect(repeated).toEqual([]);
    await expect(value.loadBaseline(account)).resolves.toMatchObject([
      { workItemKey: "item:2" },
    ]);
    await expect(value.list(account, { now })).resolves.toMatchObject({
      unreadCount: 1,
      notifications: [expect.objectContaining({ type: "assigned" })],
    });
  });

  it("isolates notifications and read operations by stable account", async () => {
    const { value } = store();
    const other = { providerId: "feishu-project", accountKey: "user-two" };
    const [created] = await value.applyScan({ account, baseline: baseline(), events: [event()], now });
    await value.applyScan({
      account: other,
      baseline: baseline("item:other"),
      events: [event({ workItemKey: "item:other", dedupeMaterial: "other" })],
      now,
    });

    await value.markRead(other, created!.id, now);
    expect((await value.list(account, { now })).unreadCount).toBe(1);
    expect((await value.list(other, { now })).notifications).toHaveLength(1);
    await value.markAllRead(account, new Date("2026-08-12T00:02:00.000Z"));
    expect((await value.list(account, { now })).unreadCount).toBe(0);
    expect((await value.list(other, { now })).unreadCount).toBe(1);
  });

  it("supports unread filtering and idempotent read operations", async () => {
    const { value } = store();
    const [created] = await value.applyScan({ account, baseline: baseline(), events: [event()], now });

    await value.markRead(account, created!.id, now);
    await value.markRead(account, created!.id, now);

    expect(await value.list(account, { now, unreadOnly: true })).toEqual({
      notifications: [],
      unreadCount: 0,
    });
  });

  it("purges events older than 30 days while retaining the account baseline", async () => {
    const { value } = store();
    const old = new Date("2026-07-12T23:59:59.999Z");
    await value.applyScan({
      account,
      baseline: baseline(),
      events: [event({ occurredAt: old.toISOString() })],
      now: old,
    });

    expect(await value.list(account, { now })).toEqual({ notifications: [], unreadCount: 0 });
    await expect(value.loadBaseline(account)).resolves.toHaveLength(1);
  });

  it.runIf(process.platform !== "win32")(
    "uses restrictive file permissions outside Windows",
    () => {
    const { path } = store();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects an unsupported schema without overwriting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "flowrivet-notifications-schema-"));
    const path = join(directory, "notifications.db");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE notification_schema(version INTEGER NOT NULL) STRICT");
    database.prepare("INSERT INTO notification_schema(version) VALUES (?)").run(99);
    database.close();

    expect(() => new SqliteNotificationStore({ path, DatabaseSync }))
      .toThrowError(expect.objectContaining({ code: "notification_store_read_failed" }));
    expect(readFileSync(path).length).toBeGreaterThan(0);
  });
});
