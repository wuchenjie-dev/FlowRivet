import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { ProjectRef } from "../src/contracts/projects.js";
import type { WorkItem, WorkItemKind } from "../src/contracts/taskboard.js";
import {
  createWorkItemCacheStore,
} from "../src/cache/create-work-item-cache-store.js";
import {
  SqliteWorkItemCacheStore,
} from "../src/cache/sqlite-work-item-cache-store.js";
import type {
  CacheAccount,
  CacheScopeInput,
} from "../src/cache/work-item-cache-store.js";

const directories: string[] = [];
const now = new Date("2026-08-10T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "flowrivet-cache-"));
  directories.push(directory);
  const path = join(directory, "flowrivet.db");
  const store = new SqliteWorkItemCacheStore({ path, DatabaseSync });
  return { directory, path, store };
}

function account(overrides: Partial<CacheAccount> = {}): CacheAccount {
  return {
    providerId: "tapd",
    accountKey: "user-1",
    tenantKey: "tenant-1",
    accountDisplayName: "Alice",
    tenantDisplayName: "Example",
    ...overrides,
  };
}

function project(externalId: string): ProjectRef {
  return {
    providerId: "tapd",
    externalId,
    name: `Project ${externalId}`,
    selected: true,
    available: true,
    source: "discovered",
    lastVerifiedAt: now.toISOString(),
  };
}

function item(
  externalId: string,
  projectExternalId = "A",
  providerItemType = "task",
  kind: WorkItemKind = "task",
): WorkItem {
  return {
    key: `tapd:${projectExternalId}:${providerItemType}:${externalId}`,
    providerId: "tapd",
    externalId,
    projectExternalId,
    projectName: `Project ${projectExternalId}`,
    kind,
    providerItemType,
    title: `Item ${externalId}`,
    stage: "todo",
    providerStatus: "open",
    freshness: "fresh",
    externalUrl: `https://example.test/${externalId}`,
  };
}

function scope(
  projectExternalId: string,
  providerItemType: string,
  kind: WorkItemKind,
  items: WorkItem[],
  outcome: "success" | "error" = "success",
): CacheScopeInput {
  return {
    projectExternalId,
    providerItemType,
    kind,
    outcome,
    items: outcome === "success" ? items : [],
    ...(outcome === "error" ? { errorCode: "work_item_sync_failed" } : {}),
  };
}

describe("SQLite work item cache store", () => {
  it("initializes repeatedly and restores validated items as cached", async () => {
    const { path, store } = await fixture();
    await store.mergeScopes({
      account: account(),
      projects: [project("A")],
      scopes: [scope("A", "task", "task", [item("1")])],
      now,
    });

    const reopened = new SqliteWorkItemCacheStore({ path, DatabaseSync });
    await expect(reopened.loadActive("tapd", now)).resolves.toMatchObject({
      account: { accountDisplayName: "Alice", tenantDisplayName: "Example" },
      projects: [{ externalId: "A" }],
      scopes: [{ providerItemType: "task", freshness: "cached" }],
      items: [{ externalId: "1", freshness: "cached" }],
      lastSuccessfulSyncAt: now.toISOString(),
    });
  });

  it("persists only hashed account identity and provider-neutral item data", async () => {
    const { path, store } = await fixture();
    await store.mergeScopes({
      account: account(),
      projects: [project("A")],
      scopes: [scope("A", "task", "task", [item("1")])],
      now,
    });

    const database = new DatabaseSync(path);
    const accountRow = database.prepare(
      "SELECT namespace_key FROM cache_accounts",
    ).get() as { namespace_key: string };
    const itemRow = database.prepare(
      "SELECT item_json FROM cache_items",
    ).get() as { item_json: string };
    database.close();

    expect(accountRow.namespace_key).toMatch(/^[a-f0-9]{64}$/);
    expect(accountRow.namespace_key).not.toContain("user-1");
    expect(accountRow.namespace_key).not.toContain("tenant-1");
    expect(itemRow.item_json).not.toContain("freshness");
    expect(JSON.parse(itemRow.item_json)).toMatchObject({
      externalId: "1",
      providerId: "tapd",
    });
  });

  it("rolls back schema initialization when table creation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-cache-init-"));
    directories.push(directory);
    const path = join(directory, "flowrivet.db");
    class FailingInitDatabase {
      private readonly database: DatabaseSync;
      constructor(location: string) {
        this.database = new DatabaseSync(location);
      }
      exec(sql: string) {
        if (sql.includes("CREATE TABLE IF NOT EXISTS cache_accounts")) {
          throw new Error("injected schema failure");
        }
        return this.database.exec(sql);
      }
      prepare(sql: string) {
        return this.database.prepare(sql);
      }
      close() {
        return this.database.close();
      }
    }

    expect(() => new SqliteWorkItemCacheStore({
      path,
      DatabaseSync: FailingInitDatabase as unknown as typeof DatabaseSync,
    })).toThrow(expect.objectContaining({ code: "cache_read_failed" }));
    const database = new DatabaseSync(path);
    const rows = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cache_schema'",
    ).all();
    database.close();
    expect(rows).toEqual([]);
  });

  it("replaces successful scopes, clears successful empty scopes, and retains failed scopes", async () => {
    const { store } = await fixture();
    await store.mergeScopes({
      account: account(), projects: [project("A")], now,
      scopes: [
        scope("A", "story", "requirement", [item("story-1", "A", "story", "requirement")]),
        scope("A", "task", "task", [item("task-1")]),
      ],
    });

    const merged = await store.mergeScopes({
      account: account(), projects: [project("A")],
      now: new Date("2026-08-10T13:00:00.000Z"),
      scopes: [
        scope("A", "story", "requirement", []),
        scope("A", "task", "task", [], "error"),
      ],
    });

    expect(merged.items).toEqual([
      expect.objectContaining({ externalId: "task-1", freshness: "cached" }),
    ]);
    expect(merged.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerItemType: "story", freshness: "fresh", items: [] }),
      expect.objectContaining({ providerItemType: "task", freshness: "cached" }),
    ]));
  });

  it("prunes projects absent from the authoritative online catalog", async () => {
    const { store } = await fixture();
    await store.mergeScopes({
      account: account(), projects: [project("A"), project("B")], now,
      scopes: [
        scope("A", "task", "task", [item("A-1")]),
        scope("B", "task", "task", [item("B-1", "B")]),
      ],
    });

    const merged = await store.mergeScopes({
      account: account(), projects: [project("A")],
      scopes: [scope("A", "task", "task", [item("A-2")])],
      now: new Date("2026-08-10T13:00:00.000Z"),
    });

    expect(merged.projects.map((entry) => entry.externalId)).toEqual(["A"]);
    expect(merged.items.map((entry) => entry.externalId)).toEqual(["A-2"]);
  });

  it("deletes the old namespace when the active account changes", async () => {
    const { path, store } = await fixture();
    await store.mergeScopes({
      account: account(), projects: [project("A")],
      scopes: [scope("A", "task", "task", [item("old")])], now,
    });
    await store.activateAccount(account({ accountKey: "user-2", accountDisplayName: "Bob" }));

    const database = new DatabaseSync(path);
    const count = database.prepare(
      "SELECT COUNT(*) AS count FROM cache_accounts WHERE account_display_name = 'Bob'",
    ).get() as { count: number };
    expect(Number(count.count)).toBe(1);
    database.close();

    await expect(store.loadActive("tapd", now)).resolves.toBeUndefined();
  });

  it("expires each scope only after its own seven-day boundary", async () => {
    const { store } = await fixture();
    await store.mergeScopes({
      account: account(), projects: [project("A")], now,
      scopes: [
        scope("A", "story", "requirement", [item("story", "A", "story", "requirement")]),
        scope("A", "task", "task", [item("task")]),
      ],
    });
    const sixDaysLater = new Date("2026-08-16T12:00:00.000Z");
    await store.mergeScopes({
      account: account(), projects: [project("A")], now: sixDaysLater,
      scopes: [
        scope("A", "story", "requirement", [item("story-new", "A", "story", "requirement")]),
        scope("A", "task", "task", [], "error"),
      ],
    });

    expect((await store.loadActive("tapd", new Date("2026-08-17T12:00:00.000Z")))?.items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ externalId: "story-new" }),
        expect.objectContaining({ externalId: "task" }),
      ]));
    expect((await store.loadActive("tapd", new Date("2026-08-17T12:00:00.001Z")))?.items)
      .toEqual([expect.objectContaining({ externalId: "story-new" })]);
  });

  it("rolls back a scope replacement when an item insert fails", async () => {
    const { path, store } = await fixture();
    await store.mergeScopes({
      account: account(), projects: [project("A")],
      scopes: [scope("A", "task", "task", [item("old")])], now,
    });
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TRIGGER reject_blocked_item
      BEFORE INSERT ON cache_items
      WHEN NEW.item_key = 'tapd:A:task:blocked'
      BEGIN SELECT RAISE(ABORT, 'blocked'); END;
    `);

    await expect(store.mergeScopes({
      account: account(), projects: [project("A")],
      scopes: [scope("A", "task", "task", [item("blocked")])],
      now: new Date("2026-08-10T13:00:00.000Z"),
    })).rejects.toMatchObject({ code: "cache_write_failed" });
    database.exec("DROP TRIGGER reject_blocked_item");
    database.close();

    expect((await store.loadActive("tapd", now))?.items)
      .toEqual([expect.objectContaining({ externalId: "old" })]);
  });

  it("rejects items whose provider identity does not match their cache scope", async () => {
    const { store } = await fixture();
    const mismatched = {
      ...item("wrong", "B", "story", "requirement"),
      providerId: "another-provider",
    };

    await expect(store.mergeScopes({
      account: account(), projects: [project("A")], now,
      scopes: [scope("A", "task", "task", [mismatched])],
    })).rejects.toMatchObject({ code: "cache_write_failed" });
    await expect(store.loadActive("tapd", now)).resolves.toBeUndefined();
  });

  it("rejects unknown schemas and invalid cached JSON without deleting the database", async () => {
    const first = await fixture();
    const unknown = new DatabaseSync(first.path);
    unknown.exec("UPDATE cache_schema SET version = 99");
    unknown.close();
    expect(() => new SqliteWorkItemCacheStore({ path: first.path, DatabaseSync }))
      .toThrow(expect.objectContaining({ code: "cache_read_failed" }));

    const second = await fixture();
    await second.store.mergeScopes({
      account: account(), projects: [project("A")],
      scopes: [scope("A", "task", "task", [item("1")])], now,
    });
    const corrupt = new DatabaseSync(second.path);
    corrupt.exec("UPDATE cache_items SET item_json = '{bad json'");
    corrupt.close();
    await expect(second.store.loadActive("tapd", now))
      .rejects.toMatchObject({ code: "cache_read_failed" });
  });

  it("clears the active account and reports a lazy unavailable runtime", async () => {
    const { directory, store } = await fixture();
    await store.mergeScopes({
      account: account(), projects: [project("A")],
      scopes: [scope("A", "task", "task", [item("1")])], now,
    });
    await store.clearActive("tapd");
    await expect(store.loadActive("tapd", now)).resolves.toBeUndefined();

    const unavailable = createWorkItemCacheStore({
      directory,
      loadSqlite: async () => {
        throw new Error("module unavailable");
      },
    });
    await expect(unavailable.loadActive("tapd", now))
      .rejects.toMatchObject({ code: "cache_unavailable" });
  });

  it("preserves database initialization errors through the lazy factory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-cache-factory-"));
    directories.push(directory);
    const database = new DatabaseSync(join(directory, "flowrivet.db"));
    database.exec("CREATE TABLE cache_schema(version INTEGER NOT NULL); INSERT INTO cache_schema VALUES (99)");
    database.close();
    const store = createWorkItemCacheStore({
      directory,
      loadSqlite: async () => ({ DatabaseSync } as typeof import("node:sqlite")),
    });

    await expect(store.loadActive("tapd", now))
      .rejects.toMatchObject({ code: "cache_read_failed" });
    const repaired = new DatabaseSync(join(directory, "flowrivet.db"));
    repaired.exec("UPDATE cache_schema SET version = 1");
    repaired.close();
    await expect(store.loadActive("tapd", now)).resolves.toBeUndefined();
  });

  it("maps runtime database open failures to stable operation errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-cache-open-"));
    directories.push(directory);
    const path = join(directory, "flowrivet.db");
    let opens = 0;
    class FailingReopenDatabase extends DatabaseSync {
      constructor(location: string) {
        opens += 1;
        if (opens > 1) throw new Error(`cannot open ${location}`);
        super(location);
      }
    }
    const store = new SqliteWorkItemCacheStore({
      path,
      DatabaseSync: FailingReopenDatabase,
    });

    await expect(store.loadActive("tapd", now))
      .rejects.toMatchObject({ code: "cache_read_failed" });
  });
});
