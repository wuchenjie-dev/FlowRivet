import type { ExecutionRecord } from "../contracts/executions.js";

export type ExecutionIdentity = Pick<ExecutionRecord, "providerId" | "accountKey" | "workItemKey">;
export type ExecutionStoreErrorCode =
  | "execution_already_exists"
  | "execution_not_found"
  | "execution_store_read_failed"
  | "execution_store_write_failed";

export class ExecutionStoreError extends Error {
  constructor(readonly code: ExecutionStoreErrorCode) {
    super(code);
    this.name = "ExecutionStoreError";
  }
}

export interface ExecutionStore {
  create(record: ExecutionRecord): Promise<void>;
  findCurrent(identity: ExecutionIdentity): Promise<ExecutionRecord | undefined>;
  findLatest(identity: ExecutionIdentity): Promise<ExecutionRecord | undefined>;
  getById(executionId: string): Promise<ExecutionRecord | undefined>;
  save(record: ExecutionRecord): Promise<void>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly records = new Map<string, ExecutionRecord>();

  async create(record: ExecutionRecord) {
    if ([...this.records.values()].some((entry) =>
      sameIdentity(entry, record) && entry.attempt === record.attempt)) {
      throw new ExecutionStoreError("execution_already_exists");
    }
    this.records.set(record.executionId, structuredClone(record));
  }
  async findCurrent(identity: ExecutionIdentity) {
    const found = matchingRecords(this.records, identity)
      .find((entry) => !terminalStates.has(entry.state));
    return found ? structuredClone(found) : undefined;
  }
  async findLatest(identity: ExecutionIdentity) {
    const found = matchingRecords(this.records, identity)[0];
    return found ? structuredClone(found) : undefined;
  }
  async getById(executionId: string) {
    const found = this.records.get(executionId);
    return found ? structuredClone(found) : undefined;
  }
  async save(record: ExecutionRecord) {
    if (!this.records.has(record.executionId)) throw new ExecutionStoreError("execution_not_found");
    this.records.set(record.executionId, structuredClone(record));
  }
}

const terminalStates = new Set<ExecutionRecord["state"]>(["completed"]);

function matchingRecords(records: Map<string, ExecutionRecord>, identity: ExecutionIdentity) {
  return [...records.values()]
    .filter((entry) => sameIdentity(entry, identity))
    .sort((left, right) => right.attempt - left.attempt);
}

function sameIdentity(a: ExecutionIdentity, b: ExecutionIdentity) {
  return a.providerId === b.providerId && a.accountKey === b.accountKey
    && a.workItemKey === b.workItemKey;
}
