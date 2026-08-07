import type { WorkItem, WorkItemKind } from "../contracts/taskboard.js";

export interface WorkItemQueryResult {
  projectExternalId: string;
  items: WorkItem[];
  failedKinds: WorkItemKind[];
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
  | "provider_unauthorized";

export class WorkItemProviderError extends Error {
  constructor(readonly code: WorkItemErrorCode) {
    super(code);
    this.name = "WorkItemProviderError";
  }
}
