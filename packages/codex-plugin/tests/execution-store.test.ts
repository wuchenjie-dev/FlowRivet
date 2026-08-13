import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { InMemoryExecutionStore } from "../src/executions/execution-store.js";
import { SqliteExecutionStore } from "../src/executions/sqlite-execution-store.js";

const identity = {
  providerId: "feishu-project" as const,
  accountKey: "user-1",
  workItemKey: "item-1",
};

describe("SQLite execution store", () => {
  it("stores independent attempts and reads the current and latest records", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "flowrivet-executions-")), "executions.db");
    const store = new SqliteExecutionStore({ path, DatabaseSync });
    const first = record({ executionId: "execution-1", state: "completed" });
    const second = record({ executionId: "execution-2", attempt: 2, state: "prepared" });

    await store.create(first);
    await store.create(second);
    await expect(store.findCurrent(identity)).resolves.toEqual(second);
    await expect(store.findLatest(identity)).resolves.toEqual(second);
    await expect(store.findCurrent({
      providerId: "feishu-project", accountKey: "user-2", workItemKey: "item-1",
    })).resolves.toBeUndefined();
  });

  it("migrates a version 1 database and permits the next attempt", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "flowrivet-executions-v1-")), "executions.db");
    createVersionOneDatabase(path, versionOneRecord({
      executionKind: "development",
      state: "awaiting_repository",
    }));

    const store = new SqliteExecutionStore({ path, DatabaseSync });

    await expect(store.findLatest(identity)).resolves.toMatchObject({
      schemaVersion: 2,
      attempt: 1,
      workMode: "code",
    });
    await store.create(record({ executionId: "execution-2", attempt: 2 }));
    await expect(store.findLatest(identity)).resolves.toMatchObject({
      executionId: "execution-2",
      attempt: 2,
    });
  });

  it("rejects a corrupt persisted payload instead of overwriting it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "flowrivet-executions-")), "executions.db");
    const store = new SqliteExecutionStore({ path, DatabaseSync });
    await store.create(record());
    const database = new DatabaseSync(path);
    database.prepare("UPDATE executions SET payload_json = ? WHERE execution_id = ?")
      .run("{not-json", "execution-1");
    database.close();

    await expect(store.getById("execution-1"))
      .rejects.toMatchObject({ code: "execution_store_read_failed" });
  });
});

describe("in-memory execution store", () => {
  it("isolates attempts while rejecting a duplicate attempt", async () => {
    const store = new InMemoryExecutionStore();
    const first = record({ executionId: "execution-1", state: "completed" });
    const second = record({ executionId: "execution-2", attempt: 2 });
    await store.create(first);
    await store.create(second);

    expect((await store.findCurrent(identity))?.executionId).toBe("execution-2");
    expect((await store.findLatest(identity))?.attempt).toBe(2);
    await expect(store.create(record({ executionId: "execution-3", attempt: 2 })))
      .rejects.toMatchObject({ code: "execution_already_exists" });
  });
});

function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2 as const,
    executionId: "execution-1",
    providerId: "feishu-project",
    accountKey: "user-1",
    workItemKey: "item-1",
    attempt: 1,
    taskLaunchMode: "handoff" as const,
    workMode: "non_code" as const,
    executionKind: "requirement_analysis" as const,
    state: "prepared" as const,
    artifacts: [],
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function versionOneRecord(overrides: Record<string, unknown> = {}) {
  const current = record(overrides);
  const { attempt: _attempt, workMode: _workMode, ...rest } = current;
  return { ...rest, schemaVersion: 1 };
}

function createVersionOneDatabase(path: string, value: Record<string, unknown>) {
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE execution_schema(version INTEGER NOT NULL) STRICT");
  database.prepare("INSERT INTO execution_schema(version) VALUES (?)").run(1);
  database.exec(`CREATE TABLE executions(
    execution_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, account_key TEXT NOT NULL,
    work_item_key TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, UNIQUE(provider_id, account_key, work_item_key)
  ) STRICT`);
  database.prepare(`INSERT INTO executions(
    execution_id, provider_id, account_key, work_item_key, payload_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    value.executionId,
    value.providerId,
    value.accountKey,
    value.workItemKey,
    JSON.stringify(value),
    value.createdAt,
    value.updatedAt,
  );
  database.close();
}
