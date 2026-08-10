import type { WorkItem, WorkItemKind } from "../contracts/taskboard.js";

export interface WorkItemQueryResult {
  projectExternalId: string;
  scopes: WorkItemScopeResult[];
}

export interface WorkItemScopeResult {
  providerItemType: string;
  kind: WorkItemKind;
  outcome: "success" | "error";
  items: WorkItem[];
  errorCode?: WorkItemErrorCode;
  retryAfterSeconds?: number;
}

export interface WorkItemProvider {
  readonly id: string;
  listProjectWorkItems(input: {
    projectExternalId: string;
    projectName: string;
    accountDisplayName: string;
  }): Promise<WorkItemQueryResult>;
}

export type WorkItemErrorCode =
  | "work_item_sync_failed"
  | "provider_unauthorized"
  | "provider_rate_limited"
  | "provider_unavailable";

export class WorkItemProviderError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(
    readonly code: WorkItemErrorCode,
    metadata: { retryAfterSeconds?: number } = {},
  ) {
    super(code);
    this.name = "WorkItemProviderError";
    this.retryAfterSeconds = metadata.retryAfterSeconds;
  }
}
