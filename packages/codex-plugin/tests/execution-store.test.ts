import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { SqliteExecutionStore } from "../src/executions/sqlite-execution-store.js";

describe("SQLite execution store", () => {
  it("enforces one execution per provider account and work item", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "flowrivet-executions-")), "executions.db");
    const store = new SqliteExecutionStore({ path, DatabaseSync });
    const first = record({ executionId: "execution-1" });
    const duplicate = record({ executionId: "execution-2" });

    await store.create(first);
    await expect(store.create(duplicate)).rejects.toMatchObject({ code: "execution_already_exists" });
    await expect(store.find({
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "item-1",
    })).resolves.toEqual(first);
    await expect(store.find({
      providerId: "feishu-project", accountKey: "user-2", workItemKey: "item-1",
    })).resolves.toBeUndefined();
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
