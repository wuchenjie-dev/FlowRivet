import {
  executionRecordSchema,
  persistedExecutionRecordV1Schema,
  type ExecutionRecord,
} from "../contracts/executions.js";

type PersistedExecutionRecordV1 = ReturnType<typeof persistedExecutionRecordV1Schema.parse>;

export function migrateExecutionRecordV1(value: PersistedExecutionRecordV1): ExecutionRecord {
  const { executionKind, ...record } = persistedExecutionRecordV1Schema.parse(value);
  const workMode = executionKind === "pending_classification" && record.state === "prepared"
    ? "pending"
    : executionKind === "development"
      ? "code"
      : "non_code";
  return executionRecordSchema.parse({
    ...record,
    schemaVersion: 2,
    attempt: 1,
    workMode,
    ...(executionKind === "pending_classification" ? {} : { executionKind }),
  });
}

export function parsePersistedExecutionRecord(value: unknown): ExecutionRecord {
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  return version === 1
    ? migrateExecutionRecordV1(persistedExecutionRecordV1Schema.parse(value))
    : executionRecordSchema.parse(value);
}
