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
  | "provider_unavailable";

export class WorkItemProviderError extends Error {
  constructor(readonly code: WorkItemErrorCode) {
    super(code);
    this.name = "WorkItemProviderError";
  }
}
