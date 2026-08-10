import {
  WorkItemCacheError,
  type CacheAccount,
  type CachedScope,
  type CachedSnapshot,
  type WorkItemCacheErrorCode,
  type WorkItemCacheStore,
} from "../cache/work-item-cache-store.js";
import type { ProjectRef } from "../contracts/projects.js";
import type { WorkItem } from "../contracts/taskboard.js";
import {
  WorkItemProviderError,
  type WorkItemErrorCode,
  type WorkItemProvider,
  type WorkItemScopeResult,
} from "./work-item-provider.js";

export interface WorkItemSyncInput {
  accountDisplayName: string;
  projects: ProjectRef[];
  cacheAccount?: CacheAccount;
}

export interface WorkItemSyncSnapshot {
  items: WorkItem[];
  projects: Array<ProjectRef & { count: number }>;
  summary: {
    successfulProjects: number;
    failedProjects: number;
    itemCount: number;
  };
  dataFreshness: "live" | "mixed" | "offline";
  freshScopeCount: number;
  staleScopeCount: number;
  lastSuccessfulSyncAt?: string;
  lastSyncAttemptAt: string;
  cacheWarningCode?: Exclude<WorkItemCacheErrorCode, "cache_clear_failed">
    | "cache_identity_unavailable";
  freshnessReasonCode?: WorkItemErrorCode;
}

export interface WorkItemSynchronizer {
  sync(input: WorkItemSyncInput): Promise<WorkItemSyncSnapshot>;
  loadCached(providerId: string): Promise<WorkItemSyncSnapshot | undefined>;
  clearCached(providerId: string): Promise<void>;
}

export class WorkItemService implements WorkItemSynchronizer {
  private inFlight?: Promise<WorkItemSyncSnapshot>;

  constructor(
    private readonly provider: WorkItemProvider,
    private readonly clock: () => Date = () => new Date(),
    private readonly cache?: WorkItemCacheStore,
  ) {}

  sync(input: WorkItemSyncInput): Promise<WorkItemSyncSnapshot> {
    if (this.inFlight) return this.inFlight;
    const operation = this.performSync(input);
    this.inFlight = operation.finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async loadCached(providerId: string): Promise<WorkItemSyncSnapshot | undefined> {
    if (!this.cache) return undefined;
    const now = this.clock();
    const snapshot = await this.cache.loadActive(providerId, now);
    if (!snapshot) return undefined;
    return createSnapshot({
      source: snapshot,
      projects: snapshot.projects,
      successfulProjects: 0,
      failedProjects: 0,
      lastSyncAttemptAt: now.toISOString(),
    }, now);
  }

  async clearCached(providerId: string): Promise<void> {
    await this.cache?.clearActive(providerId);
  }

  private async performSync(input: WorkItemSyncInput): Promise<WorkItemSyncSnapshot> {
    const projects = input.projects.filter((project) => project.available);
    const scopes: Array<WorkItemScopeResult & { projectExternalId: string }> = [];
    const failureCodes: WorkItemErrorCode[] = [];
    let successfulProjects = 0;
    let failedProjects = 0;
    let nextIndex = 0;
    const attemptedAt = this.clock();

    const consumeNextProject = async (): Promise<void> => {
      while (nextIndex < projects.length) {
        const project = projects[nextIndex++];
        if (!project) return;
        try {
          const result = await this.provider.listProjectWorkItems({
            projectExternalId: project.externalId,
            projectName: project.name,
            accountDisplayName: input.accountDisplayName,
          });
          const successfulScopes = result.scopes.filter((scope) => scope.outcome === "success");
          const failedScopes = result.scopes.length - successfulScopes.length;
          scopes.push(...result.scopes.map((scope) => ({
            ...scope,
            projectExternalId: project.externalId,
          })));
          failureCodes.push(...result.scopes
            .filter((scope) => scope.outcome === "error")
            .map((scope) => scope.errorCode ?? "work_item_sync_failed"));
          if (failedScopes === 0) {
            successfulProjects += 1;
          } else {
            failedProjects += 1;
          }
        } catch (error) {
          failedProjects += 1;
          failureCodes.push(providerErrorCode(error));
        }
      }
    };

    const workerCount = Math.min(4, projects.length);
    await Promise.all(Array.from({ length: workerCount }, consumeNextProject));
    const successfulScopes = scopes.filter((scope) => scope.outcome === "success");
    const reason = preferredFailureCode(failureCodes);
    let cacheWarningCode: WorkItemSyncSnapshot["cacheWarningCode"];
    let source: CachedSnapshot;

    if (this.cache && input.cacheAccount) {
      try {
        source = await this.cache.mergeScopes({
          account: input.cacheAccount,
          projects,
          scopes,
          now: attemptedAt,
        });
      } catch (error) {
        cacheWarningCode = cacheWarning(error);
        source = liveSnapshot(input.cacheAccount, projects, successfulScopes, attemptedAt);
      }
    } else {
      if (this.cache) cacheWarningCode = "cache_identity_unavailable";
      source = liveSnapshot(
        input.cacheAccount ?? {
          providerId: this.provider.id,
          accountKey: "",
          accountDisplayName: input.accountDisplayName,
        },
        projects,
        successfulScopes,
        attemptedAt,
      );
    }

    const hasUsableScopes = source.scopes.length > 0;
    if (projects.length > 0 && !hasUsableScopes) {
      throw new WorkItemProviderError(reason ?? "work_item_sync_failed");
    }

    return createSnapshot({
      source,
      projects,
      successfulProjects,
      failedProjects,
      lastSyncAttemptAt: attemptedAt.toISOString(),
      cacheWarningCode,
      freshnessReasonCode: reason,
    }, attemptedAt);
  }
}

function liveSnapshot(
  account: CacheAccount,
  projects: ProjectRef[],
  scopes: Array<WorkItemScopeResult & { projectExternalId: string }>,
  now: Date,
): CachedSnapshot {
  const cachedScopes: CachedScope[] = scopes.map((scope) => ({
    projectExternalId: scope.projectExternalId,
    providerItemType: scope.providerItemType,
    kind: scope.kind,
    freshness: "fresh",
    lastSuccessfulSyncAt: now.toISOString(),
    items: scope.items.map((item) => ({ ...item, freshness: "fresh" })),
  }));
  return {
    account: {
      providerId: account.providerId,
      accountDisplayName: account.accountDisplayName,
      ...(account.tenantDisplayName
        ? { tenantDisplayName: account.tenantDisplayName }
        : {}),
    },
    projects,
    scopes: cachedScopes,
    items: cachedScopes.flatMap((scope) => scope.items),
    ...(cachedScopes.length > 0 ? { lastSuccessfulSyncAt: now.toISOString() } : {}),
  };
}

function createSnapshot(
  input: {
    source: CachedSnapshot;
    projects: ProjectRef[];
    successfulProjects: number;
    failedProjects: number;
    lastSyncAttemptAt: string;
    cacheWarningCode?: WorkItemSyncSnapshot["cacheWarningCode"];
    freshnessReasonCode?: WorkItemErrorCode;
  },
  now: Date,
): WorkItemSyncSnapshot {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const items = input.source.items
    .filter((item) => item.stage !== "done"
      || Boolean(item.completedAt && new Date(item.completedAt).getTime() >= cutoff))
    .sort(compareItems);
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.projectExternalId, (counts.get(item.projectExternalId) ?? 0) + 1);
  }
  const countedProjects = input.projects
    .map((project) => ({ ...project, count: counts.get(project.externalId) ?? 0 }))
    .sort((left, right) => left.name.localeCompare(right.name)
      || left.externalId.localeCompare(right.externalId));
  const freshScopeCount = input.source.scopes
    .filter((scope) => scope.freshness === "fresh").length;
  const staleScopeCount = input.source.scopes.length - freshScopeCount;
  const dataFreshness = freshScopeCount > 0
    ? (staleScopeCount > 0 ? "mixed" : "live")
    : (staleScopeCount > 0 ? "offline" : "live");

  return {
    items,
    projects: countedProjects,
    summary: {
      successfulProjects: input.successfulProjects,
      failedProjects: input.failedProjects,
      itemCount: items.length,
    },
    dataFreshness,
    freshScopeCount,
    staleScopeCount,
    lastSyncAttemptAt: input.lastSyncAttemptAt,
    ...(input.source.lastSuccessfulSyncAt
      ? { lastSuccessfulSyncAt: input.source.lastSuccessfulSyncAt }
      : {}),
    ...(input.cacheWarningCode ? { cacheWarningCode: input.cacheWarningCode } : {}),
    ...(input.freshnessReasonCode
      ? { freshnessReasonCode: input.freshnessReasonCode }
      : {}),
  };
}

function providerErrorCode(error: unknown): WorkItemErrorCode {
  return error instanceof WorkItemProviderError ? error.code : "work_item_sync_failed";
}

function preferredFailureCode(codes: WorkItemErrorCode[]): WorkItemErrorCode | undefined {
  if (codes.includes("provider_unauthorized")) return "provider_unauthorized";
  if (codes.includes("provider_unavailable")) return "provider_unavailable";
  return codes.length > 0 ? "work_item_sync_failed" : undefined;
}

function cacheWarning(error: unknown): WorkItemSyncSnapshot["cacheWarningCode"] {
  if (error instanceof WorkItemCacheError && error.code !== "cache_clear_failed") {
    return error.code;
  }
  return "cache_write_failed";
}

function compareItems(left: WorkItem, right: WorkItem) {
  return left.projectName.localeCompare(right.projectName)
    || left.kind.localeCompare(right.kind)
    || left.externalId.localeCompare(right.externalId);
}
