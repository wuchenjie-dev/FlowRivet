import type { ProjectRef } from "../contracts/projects.js";
import type { WorkItem, WorkItemKind } from "../contracts/taskboard.js";
import type { WorkItemErrorCode } from "../work-items/work-item-provider.js";

export interface CacheAccount {
  providerId: string;
  accountKey: string;
  tenantKey?: string;
  accountDisplayName: string;
  tenantDisplayName?: string;
}

export interface CacheScopeInput {
  projectExternalId: string;
  providerItemType: string;
  kind: WorkItemKind;
  outcome: "success" | "error";
  items: WorkItem[];
  errorCode?: WorkItemErrorCode;
}

export interface CacheMergeInput {
  account: CacheAccount;
  projects: ProjectRef[];
  scopes: CacheScopeInput[];
  authoritativeProjects?: boolean;
  authoritativeProjectScopePrefixes?: string[];
  authoritativeProviderItemTypes?: string[];
  authoritativeScopePrefixes?: Array<{
    projectExternalId: string;
    providerItemTypePrefix: string;
  }>;
  now: Date;
}

export interface CachedScope {
  projectExternalId: string;
  providerItemType: string;
  kind: WorkItemKind;
  freshness: WorkItem["freshness"];
  lastSuccessfulSyncAt: string;
  items: WorkItem[];
}

export interface CachedSnapshot {
  account: Pick<
    CacheAccount,
    "providerId" | "accountDisplayName" | "tenantDisplayName"
  >;
  projects: ProjectRef[];
  scopes: CachedScope[];
  items: WorkItem[];
  lastSuccessfulSyncAt?: string;
}

export interface WorkItemCacheStore {
  activateAccount(input: CacheAccount): Promise<void>;
  mergeScopes(input: CacheMergeInput): Promise<CachedSnapshot>;
  loadActive(providerId: string, now: Date): Promise<CachedSnapshot | undefined>;
  clearActive(providerId: string): Promise<void>;
  purgeExpired(now: Date): Promise<number>;
}

export type WorkItemCacheErrorCode =
  | "cache_unavailable"
  | "cache_read_failed"
  | "cache_write_failed"
  | "cache_clear_failed";

export class WorkItemCacheError extends Error {
  constructor(readonly code: WorkItemCacheErrorCode) {
    super(code);
    this.name = "WorkItemCacheError";
  }
}
