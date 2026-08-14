import type { WorkItem, WorkItemKind } from "../contracts/taskboard.js";
import type { ProjectRef } from "../contracts/projects.js";

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

export interface ProjectScopedWorkItemProvider {
  readonly id: string;
  readonly queryMode: "project_scoped";
  listProjectWorkItems(input: {
    projectExternalId: string;
    projectName: string;
    accountDisplayName: string;
    accountKey?: string;
    tenantKey?: string;
  }): Promise<WorkItemQueryResult>;
}

export interface AccountWorkItemScopeResult extends WorkItemScopeResult {
  projectExternalId: string;
}

export interface AccountWorkItemQueryResult {
  projects: ProjectRef[];
  scopes: AccountWorkItemScopeResult[];
  authoritativeProjects?: boolean;
  authoritativeProjectScopePrefixes?: string[];
  authoritativeProviderItemTypes?: string[];
  authoritativeScopePrefixes?: Array<{
    projectExternalId: string;
    providerItemTypePrefix: string;
  }>;
  authoritativeScopeInventories?: Array<{
    projectExternalId: string;
    providerItemTypePrefix: string;
    providerItemTypes: string[];
  }>;
  createdSyncCoverage?: CreatedSyncCoverage;
}

export type CreatedSyncCoverage =
  | {
    catalog: "available";
    mode: "manual" | "automatic";
    scannedTypeCount: number;
    totalTypeCount: number;
    complete: boolean;
  }
  | {
    catalog: "partial";
    mode: "manual" | "automatic";
    scannedTypeCount: number;
    knownTypeCount: number;
    failedProjectCount: number;
    complete: false;
  }
  | {
    catalog: "unavailable";
    mode: "manual" | "automatic";
    scannedTypeCount: 0;
    complete: false;
  };

export interface AccountScopedWorkItemProvider {
  readonly id: string;
  readonly queryMode: "account_scoped";
  listAccountWorkItems(input: {
    accountDisplayName: string;
    accountKey?: string;
    tenantKey?: string;
    syncSessionKey?: string;
    refreshMode?: "manual" | "automatic";
  }): Promise<AccountWorkItemQueryResult>;
}

export type WorkItemProvider =
  | ProjectScopedWorkItemProvider
  | AccountScopedWorkItemProvider;

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
