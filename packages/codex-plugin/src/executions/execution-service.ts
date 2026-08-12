import { randomUUID } from "node:crypto";

import {
  executionRecordSchema,
  type ExecutionKind,
  type ExecutionRepository,
  type ExecutionState,
} from "../contracts/executions.js";
import { ExecutionStoreError, type ExecutionIdentity, type ExecutionStore } from "./execution-store.js";

export type ExecutionServiceErrorCode =
  | "execution_repository_locked"
  | "execution_not_found"
  | "execution_transition_invalid";
export class ExecutionServiceError extends Error {
  constructor(readonly code: ExecutionServiceErrorCode) { super(code); this.name = "ExecutionServiceError"; }
}

export class ExecutionService {
  private readonly store: ExecutionStore;
  private readonly clock: () => Date;
  private readonly createId: () => string;
  constructor(options: { store: ExecutionStore; clock?: () => Date; createId?: () => string }) {
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async prepare(input: ExecutionIdentity & {
    taskLaunchMode: "direct" | "handoff";
    executionKind: ExecutionKind;
    workItemUpdatedAt?: string;
  }) {
    const existing = await this.store.find(input);
    if (existing) return existing;
    const timestamp = this.clock().toISOString();
    const record = executionRecordSchema.parse({
      schemaVersion: 1,
      executionId: this.createId(),
      providerId: input.providerId,
      accountKey: input.accountKey,
      workItemKey: input.workItemKey,
      ...(input.workItemUpdatedAt ? { workItemUpdatedAt: input.workItemUpdatedAt } : {}),
      taskLaunchMode: input.taskLaunchMode,
      executionKind: input.executionKind,
      state: input.executionKind === "development" ? "awaiting_repository" : "prepared",
      artifacts: [], createdAt: timestamp, updatedAt: timestamp,
    });
    try { await this.store.create(record); return record; }
    catch (error) {
      if (error instanceof ExecutionStoreError && error.code === "execution_already_exists") {
        return (await this.store.find(input))!;
      }
      throw error;
    }
  }

  get(identity: ExecutionIdentity) { return this.store.find(identity); }

  async bindRepository(executionId: string, repository: ExecutionRepository) {
    const record = await this.store.getById(executionId);
    if (!record) throw new ExecutionServiceError("execution_not_found");
    if (record.gitlab && record.gitlab.projectPath !== repository.projectPath
      && (record.gitlab.branch || record.gitlab.mergeRequestIid)) {
      throw new ExecutionServiceError("execution_repository_locked");
    }
    const updated = executionRecordSchema.parse({
      ...record,
      gitlab: repository,
      state: "ready",
      updatedAt: this.clock().toISOString(),
    });
    await this.store.save(updated);
    return updated;
  }

  async transition(executionId: string, state: ExecutionState) {
    const record = await this.store.getById(executionId);
    if (!record) throw new ExecutionServiceError("execution_not_found");
    if (record.state !== state && !allowedTransitions[record.state].includes(state)) {
      throw new ExecutionServiceError("execution_transition_invalid");
    }
    const updated = executionRecordSchema.parse({
      ...record, state, updatedAt: this.clock().toISOString(),
    });
    await this.store.save(updated);
    return updated;
  }
}

const allowedTransitions: Record<ExecutionState, ExecutionState[]> = {
  prepared: ["awaiting_repository", "ready", "running", "failed"],
  awaiting_repository: ["ready", "failed"],
  ready: ["running", "failed"],
  running: ["awaiting_confirmation", "writeback_pending", "completed", "failed"],
  awaiting_confirmation: ["running", "writeback_pending", "completed", "failed"],
  writeback_pending: ["completed", "failed"],
  completed: [],
  failed: ["prepared", "awaiting_repository", "ready", "running"],
};
