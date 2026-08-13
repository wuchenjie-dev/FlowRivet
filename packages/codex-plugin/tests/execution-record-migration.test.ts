import { describe, expect, it } from "vitest";

import {
  migrateExecutionRecordV1,
  parsePersistedExecutionRecord,
} from "../src/executions/execution-record-migration.js";

describe("execution record migration", () => {
  it.each([
    ["pending_classification", "prepared", "pending"],
    ["development", "awaiting_repository", "code"],
    ["requirement_analysis", "ready", "non_code"],
  ] as const)("maps %s in %s to %s", (executionKind, state, workMode) => {
    expect(migrateExecutionRecordV1(v1({ executionKind, state }))).toMatchObject({
      schemaVersion: 2,
      attempt: 1,
      workMode,
    });
  });

  it("passes a valid version 2 record through unchanged", () => {
    const record = {
      ...v1(),
      schemaVersion: 2 as const,
      attempt: 3,
      workMode: "non_code" as const,
      executionKind: "requirement_analysis" as const,
    };

    expect(parsePersistedExecutionRecord(record)).toEqual(record);
  });
});

function v1(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    executionId: "execution-1",
    providerId: "feishu-project" as const,
    accountKey: "user-1",
    workItemKey: "item-1",
    taskLaunchMode: "handoff" as const,
    executionKind: "requirement_analysis" as const,
    state: "ready" as const,
    artifacts: [],
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}
