import type { ProjectRef } from "../contracts/projects.js";
import type {
  CanonicalStage,
  WorkItem,
  WorkItemKind,
} from "../contracts/taskboard.js";
import {
  createdSyncIdentityHash,
  NoopCreatedSyncDiagnosticLogger,
  type CreatedSyncDiagnosticEvent,
  type CreatedSyncDiagnosticLogger,
} from "../observability/created-sync-diagnostic-logger.js";
import {
  WorkItemProviderError,
  type AccountScopedWorkItemProvider,
  type AccountWorkItemQueryResult,
  type CreatedSyncCoverage,
  type WorkItemErrorCode,
} from "../work-items/work-item-provider.js";
import type {
  MeegleCreatedBaseQuery,
  MeegleCreatedCompletionQuery,
  MeegleMyWorkPage,
  MeegleProject,
  MeegleUser,
  MeegleWorkItemType,
} from "./meegle-cli-contracts.js";
import {
  CreatedSyncScheduler,
  type CreatedSyncCommitToken,
} from "./created-sync-scheduler.js";
import {
  MeegleCliError,
  type MeegleMyWorkAction,
} from "./meegle-cli-client.js";

export interface MeegleWorkItemClient {
  getCurrentProfile(): Promise<string>;
  getCurrentUser(profile: string): Promise<MeegleUser>;
  getProjectSimpleName(profile: string, projectKey: string): Promise<string | undefined>;
  listRecentProjects(profile: string): Promise<MeegleProject[]>;
  listWorkItemTypes(profile: string, projectKey: string): Promise<MeegleWorkItemType[]>;
  hasCreatedOwnerField(
    profile: string, projectKey: string, workItemType: string,
  ): Promise<boolean>;
  queryCreatedBaseWorkItems(
    profile: string, project: MeegleProject, workItemType: MeegleWorkItemType,
  ): Promise<MeegleCreatedBaseQuery>;
  queryCreatedCompletionWorkItems(
    profile: string, project: MeegleProject, workItemType: MeegleWorkItemType,
  ): Promise<MeegleCreatedCompletionQuery>;
  getMyWorkPage(
    profile: string,
    action: MeegleMyWorkAction,
    pageNum: number,
  ): Promise<MeegleMyWorkPage>;
}

type RawItem = NonNullable<MeegleMyWorkPage["list"]>[number];
type ActionResult =
  | { action: MeegleMyWorkAction; outcome: "success"; items: RawItem[] }
  | { action: MeegleMyWorkAction; outcome: "error"; errorCode: WorkItemErrorCode };
interface CreatedItemData {
  externalId: string;
  title: string;
  statusKey: string;
  statusLabel: string;
  finishTime?: string;
}
type CreatedResult =
  | {
    outcome: "success";
    project: MeegleProject;
    workItemType: MeegleWorkItemType;
    items: CreatedItemData[];
  }
  | {
    outcome: "error";
    project?: MeegleProject;
    workItemType?: MeegleWorkItemType;
    projectExternalId: string;
    providerItemType: string;
    errorCode: WorkItemErrorCode;
  };
interface CreatedDirectory {
  discoveredProjects: MeegleProject[];
  projects: Array<{ project: MeegleProject; workItemTypes: MeegleWorkItemType[] }>;
  errors: CreatedResult[];
}
class CreatedDirectoryCancelledError extends Error {
  constructor(
    readonly cancellation: MeegleCliError,
    readonly directory: CreatedDirectory,
  ) {
    super(cancellation.message);
    this.name = "CreatedDirectoryCancelledError";
  }
}
interface CreatedFetchResult {
  authoritativeProjectScopePrefixes: string[];
  discoveredProjects: MeegleProject[];
  authoritativeProjectIds: string[];
  authoritativeScopeInventories: NonNullable<
    AccountWorkItemQueryResult["authoritativeScopeInventories"]
  >;
  coverage: CreatedSyncCoverage;
  diagnostic: Omit<CreatedSyncDiagnosticEvent, "batchCompleted">;
  commitToken?: CreatedSyncCommitToken;
  results: CreatedResult[];
}

const actions: MeegleMyWorkAction[] = ["todo", "this_week", "overdue", "done"];
const kinds: WorkItemKind[] = ["requirement", "task", "defect", "other"];
const pageSize = 50;
const maximumPages = 1_000;
const maximumItems = 50_000;
const createdPageSize = 50;
const maximumCreatedItems = 10_000;
const maximumTypesPerProject = 200;
const directoryTtlMs = 10 * 60 * 1_000;
const createdConcurrency = 4;
const maximumCreatedTypeQueriesPerSync = 40;

export class MeegleWorkItemProvider implements AccountScopedWorkItemProvider {
  readonly id = "feishu-project";
  readonly queryMode = "account_scoped" as const;

  private readonly client: MeegleWorkItemClient;
  private readonly clock: () => Date;
  private readonly diagnosticLogger: CreatedSyncDiagnosticLogger;
  private readonly createdSyncScheduler = new CreatedSyncScheduler({
    automaticLimit: maximumCreatedTypeQueriesPerSync,
  });
  private directoryCache?: {
    identityKey: string;
    expiresAt: number;
    discoveredProjects: MeegleProject[];
    successfulTypes: Map<string, MeegleWorkItemType[]>;
  };

  constructor(options: {
    client: MeegleWorkItemClient;
    clock?: () => Date;
    diagnosticLogger?: CreatedSyncDiagnosticLogger;
  }) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date());
    this.diagnosticLogger = options.diagnosticLogger ?? new NoopCreatedSyncDiagnosticLogger();
  }

  async listAccountWorkItems(input: {
    accountDisplayName: string;
    accountKey?: string;
    tenantKey?: string;
    syncSessionKey?: string;
    refreshMode?: "manual" | "automatic";
  }): Promise<AccountWorkItemQueryResult> {
    const profile = await this.captureProfile();
    if (input.syncSessionKey && input.syncSessionKey !== profile) {
      throw new WorkItemProviderError("provider_unauthorized");
    }
    const before = await this.captureIdentity(profile);
    if (input.accountKey && input.accountKey !== before.user_key) {
      throw new WorkItemProviderError("provider_unauthorized");
    }

    const mode = input.refreshMode ?? "manual";
    let created: CreatedFetchResult | undefined;
    let diagnostic: Omit<CreatedSyncDiagnosticEvent, "batchCompleted"> | undefined;
    const beginDiagnostic = (event: Omit<CreatedSyncDiagnosticEvent, "batchCompleted">) => {
      diagnostic ??= event;
    };
    let batchCompleted = false;
    try {
      const fetched = await Promise.all([
        this.fetchActions(profile),
        this.fetchCreated(profile, before.user_key, mode, beginDiagnostic),
      ]);
      const results = fetched[0];
      created = fetched[1];

      const knownSimpleNames = new Map<string, string>();
      for (const result of created.results) {
        if (result.project) knownSimpleNames.set(result.project.project_key, result.project.simple_name);
      }
      const projectSimpleNames = await this.resolveProjectSimpleNames(profile, results, knownSimpleNames);
      const afterProfile = await this.captureProfile();
      const after = await this.captureIdentity(profile);
      if (afterProfile !== profile || after.user_key !== before.user_key) {
        throw new WorkItemProviderError("provider_unauthorized");
      }
      const normalized = this.normalize(results, created, projectSimpleNames);
      if (created.commitToken) this.createdSyncScheduler.commit(created.commitToken);
      batchCompleted = true;
      return normalized;
    } finally {
      if (diagnostic) {
        try {
          this.diagnosticLogger.completed({ ...diagnostic, batchCompleted });
        } catch {
          // Diagnostics must never change synchronization behavior.
        }
      }
    }
  }

  private async fetchActions(profile: string): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < actions.length) {
        const action = actions[nextIndex++];
        if (!action) return;
        try {
          results.push({
            action,
            outcome: "success",
            items: await this.fetchAllPages(profile, action),
          });
        } catch (error) {
          results.push({ action, outcome: "error", errorCode: providerErrorCode(error) });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return results.sort((left, right) => actions.indexOf(left.action) - actions.indexOf(right.action));
  }

  private async fetchAllPages(profile: string, action: MeegleMyWorkAction) {
    const items: RawItem[] = [];
    let reportedTotal: number | undefined;
    for (let page = 1; page <= maximumPages; page += 1) {
      const result = await this.client.getMyWorkPage(profile, action, page);
      if (reportedTotal === undefined) {
        reportedTotal = result.total;
      } else if (result.total !== reportedTotal) {
        throw new WorkItemProviderError("provider_unavailable");
      }
      const pageItems = result.list ?? [];
      if (items.length + pageItems.length > maximumItems
        || items.length + pageItems.length > reportedTotal) {
        throw new WorkItemProviderError("provider_unavailable");
      }
      items.push(...pageItems);
      if (result.list === null || pageItems.length < pageSize) {
        if (items.length !== reportedTotal) {
          throw new WorkItemProviderError("provider_unavailable");
        }
        return items;
      }
    }
    if (items.length !== reportedTotal) {
      throw new WorkItemProviderError("provider_unavailable");
    }
    throw new WorkItemProviderError("provider_unavailable");
  }

  private async fetchCreated(
    profile: string,
    userKey: string,
    mode: "manual" | "automatic",
    onDiagnostic: (event: Omit<CreatedSyncDiagnosticEvent, "batchCompleted">) => void,
  ): Promise<CreatedFetchResult> {
    let directory: CreatedDirectory;
    try {
      directory = await this.getCreatedDirectory(profile, userKey);
    } catch (error) {
      if (error instanceof CreatedDirectoryCancelledError) {
        const successfulProjectCount = error.directory.projects.length;
        const totalTypeCount = countDirectoryTypes(error.directory.projects);
        onDiagnostic({
          mode,
          catalog: successfulProjectCount > 0 ? "partial" : "unavailable",
          totalTypeCount,
          scannedTypeCount: 0,
          attemptedIdentityHashes: [],
        });
        throw error.cancellation;
      }
      if (isProviderCancelled(error)) {
        onDiagnostic({
          mode,
          catalog: "unavailable",
          totalTypeCount: 0,
          scannedTypeCount: 0,
          attemptedIdentityHashes: [],
        });
        throw error;
      }
      const diagnostic = {
        mode,
        catalog: "unavailable" as const,
        totalTypeCount: 0,
        scannedTypeCount: 0,
        attemptedIdentityHashes: [],
      };
      onDiagnostic(diagnostic);
      return {
        authoritativeProjectScopePrefixes: [],
        discoveredProjects: [],
        authoritativeProjectIds: [],
        authoritativeScopeInventories: [],
        coverage: { catalog: "unavailable", mode, scannedTypeCount: 0, complete: false },
        diagnostic,
        results: [{
          outcome: "error",
          projectExternalId: "account:created",
          providerItemType: "created:catalog",
          errorCode: providerErrorCode(error),
        }],
      };
    }

    const results: CreatedResult[] = [...directory.errors];
    const available = directory.errors.length === 0;
    const byIdentity = new Map(directory.projects.flatMap(({ project, workItemTypes }) =>
      workItemTypes.map((workItemType) => [
        createdScopeKey(project, workItemType),
        { project, workItemType },
      ] as const)));
    const allTypes = [...byIdentity.values()].map(({ project, workItemType }) => ({
      projectKey: project.project_key,
      typeKey: workItemType.type_key,
    }));
    const selection = { identityKey: `${profile}\0${userKey}`, types: allTypes };
    const batch = mode === "automatic"
      ? this.createdSyncScheduler.select({ ...selection, mode: "automatic" })
      : this.createdSyncScheduler.select({ ...selection, mode: "manual" });
    const requests = batch.selected.flatMap(({ projectKey, typeKey }) => {
      const request = byIdentity.get(`${projectKey}\0${typeKey}`);
      return request ? [request] : [];
    });
    const attemptedIdentityHashes: string[] = [];
    const diagnostic = {
      mode,
      catalog: available ? "available" as const : "partial" as const,
      totalTypeCount: allTypes.length,
      scannedTypeCount: requests.length,
      attemptedIdentityHashes,
    };
    onDiagnostic(diagnostic);
    let reportedCreatedCount = 0;
    const reserveCreatedCount = (count: number) => {
      reportedCreatedCount += count;
      if (reportedCreatedCount > maximumCreatedItems) {
        throw new WorkItemProviderError("provider_unavailable");
      }
    };
    let nextIndex = 0;
    let cancellation: MeegleCliError | undefined;
    const worker = async () => {
      while (!cancellation && nextIndex < requests.length) {
        const request = requests[nextIndex++];
        if (!request) return;
        const identityHash = createdSyncIdentityHash(
          request.project.project_key,
          request.workItemType.type_key,
        );
        if (!attemptedIdentityHashes.includes(identityHash)) {
          attemptedIdentityHashes.push(identityHash);
        }
        try {
          const items = await this.fetchCreatedType(
            profile, request.project, request.workItemType, reserveCreatedCount,
          );
          results.push({ outcome: "success", ...request, items });
        } catch (error) {
          if (isProviderCancelled(error)) {
            cancellation ??= error;
            return;
          }
          results.push({
            outcome: "error",
            ...request,
            projectExternalId: request.project.project_key,
            providerItemType: `created:${request.workItemType.type_key}`,
            errorCode: providerErrorCode(error),
          });
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(createdConcurrency, Math.max(1, requests.length)) },
      () => worker(),
    ));
    diagnostic.scannedTypeCount = attemptedIdentityHashes.length;
    if (cancellation) throw cancellation;

    const coverage: CreatedSyncCoverage = available
      ? {
        catalog: "available",
        mode,
        scannedTypeCount: requests.length,
        totalTypeCount: allTypes.length,
        complete: mode === "manual" || (allTypes.length <= maximumCreatedTypeQueriesPerSync
          && requests.length === allTypes.length),
      }
      : {
        catalog: "partial",
        mode,
        scannedTypeCount: requests.length,
        knownTypeCount: allTypes.length,
        failedProjectCount: directory.errors.length,
        complete: false,
      };
    const authoritativeScopeInventories = directory.projects
      .map(({ project, workItemTypes }) => ({
        projectExternalId: project.project_key,
        providerItemTypePrefix: "created:",
        providerItemTypes: [...new Set(workItemTypes.map(({ type_key }) => `created:${type_key}`))]
          .sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.projectExternalId.localeCompare(right.projectExternalId));
    return {
      authoritativeProjectScopePrefixes: ["created:"],
      discoveredProjects: directory.discoveredProjects,
      authoritativeProjectIds: directory.projects.map(({ project }) => project.project_key),
      authoritativeScopeInventories,
      coverage,
      diagnostic,
      ...(batch.mode === "automatic" ? { commitToken: batch.commitToken } : {}),
      results,
    };
  }

  private async getCreatedDirectory(profile: string, userKey: string): Promise<CreatedDirectory> {
    const identityKey = `${profile}\0${userKey}`;
    const timestamp = this.clock().getTime();
    if (this.directoryCache?.identityKey !== identityKey
      || this.directoryCache.expiresAt <= timestamp) {
      const discoveredProjects = await this.client.listRecentProjects(profile);
      this.directoryCache = {
        identityKey,
        expiresAt: timestamp + directoryTtlMs,
        discoveredProjects,
        successfulTypes: new Map(),
      };
    }

    const cache = this.directoryCache;
    const recentProjects = cache.discoveredProjects;
    const projects: CreatedDirectory["projects"] = [];
    const errors: CreatedResult[] = [];
    let nextIndex = 0;
    let cancellation: MeegleCliError | undefined;
    const worker = async () => {
      while (!cancellation && nextIndex < recentProjects.length) {
        const project = recentProjects[nextIndex++];
        if (!project) return;
        const cachedTypes = cache.successfulTypes.get(project.project_key);
        if (cachedTypes) {
          projects.push({ project, workItemTypes: cachedTypes });
          continue;
        }
        try {
          const workItemTypes = (await this.client.listWorkItemTypes(profile, project.project_key))
            .sort((left, right) => left.type_key.localeCompare(right.type_key));
          if (workItemTypes.length > maximumTypesPerProject) {
            throw new WorkItemProviderError("provider_unavailable");
          }
          cache.successfulTypes.set(project.project_key, workItemTypes);
          projects.push({ project, workItemTypes });
        } catch (error) {
          if (isProviderCancelled(error)) {
            cancellation ??= error;
            return;
          }
          errors.push({
            outcome: "error",
            project,
            projectExternalId: project.project_key,
            providerItemType: "created:catalog",
            errorCode: providerErrorCode(error),
          });
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(createdConcurrency, Math.max(1, recentProjects.length)) },
      () => worker(),
    ));
    if (cancellation) {
      throw new CreatedDirectoryCancelledError(cancellation, {
        discoveredProjects: recentProjects,
        projects,
        errors,
      });
    }
    const order = new Map(recentProjects.map((project, index) => [project.project_key, index]));
    projects.sort((left, right) =>
      (order.get(left.project.project_key) ?? 0) - (order.get(right.project.project_key) ?? 0));
    return { discoveredProjects: recentProjects, projects, errors };
  }

  private async fetchCreatedType(
    profile: string,
    project: MeegleProject,
    workItemType: MeegleWorkItemType,
    reserveCount: (count: number) => void,
  ): Promise<CreatedItemData[]> {
    const hasOwner = await this.client.hasCreatedOwnerField(
      profile, project.project_key, workItemType.type_key,
    );
    if (!hasOwner) return [];
    const baseQuery = await this.client.queryCreatedBaseWorkItems(profile, project, workItemType);
    const baseItems = parseCreatedQuery(baseQuery, false);
    reserveCount(baseItems.length);
    const activeItems = baseItems.filter((item) => createdStage(item) !== "done");
    const completedItems = baseItems.filter((item) => createdStage(item) === "done");
    if (completedItems.length === 0) return activeItems;

    try {
      const completionQuery = await this.client.queryCreatedCompletionWorkItems(
        profile, project, workItemType,
      );
      const enrichment = parseCreatedQuery(completionQuery, true);
      if (!sameCreatedIds(baseItems, enrichment)) return activeItems;
      const finishTimes = new Map(enrichment.map((item) => [item.externalId, item.finishTime]));
      return [
        ...activeItems,
        ...completedItems.flatMap((item) => {
          const finishTime = normalizedDate(finishTimes.get(item.externalId));
          return finishTime ? [{ ...item, finishTime }] : [];
        }),
      ];
    } catch (error) {
      if (isProviderCancelled(error)) throw error;
      return activeItems;
    }
  }

  private async resolveProjectSimpleNames(
    profile: string,
    results: ActionResult[],
    knownSimpleNames: ReadonlyMap<string, string>,
  ) {
    const projectKeys = new Set<string>();
    for (const result of results) {
      if (result.outcome !== "success") continue;
      for (const item of result.items) {
        const projectKey = item.project_key.trim();
        if (projectKey) projectKeys.add(projectKey);
      }
    }

    const simpleNames = new Map(knownSimpleNames);
    for (const projectKey of projectKeys) {
      if (simpleNames.has(projectKey)) continue;
      try {
        const simpleName = await this.client.getProjectSimpleName(profile, projectKey);
        if (simpleName) simpleNames.set(projectKey, simpleName);
      } catch {
        // A failed project lookup must not hide otherwise usable work items.
      }
    }
    return simpleNames;
  }

  private normalize(
    results: ActionResult[],
    created: CreatedFetchResult,
    projectSimpleNames: ReadonlyMap<string, string>,
  ): AccountWorkItemQueryResult {
    const createdResults = created.results;
    const cutoff = this.clock().getTime() - 7 * 24 * 60 * 60 * 1_000;
    const nodeIdentities = collectNodeIdentities(results);
    const winners = new Map<string,
      | { source: "mywork"; action: MeegleMyWorkAction; item: WorkItem }
      | { source: "created"; scopeKey: string; item: WorkItem }>();
    for (const result of results) {
      if (result.outcome === "error") continue;
      for (const raw of result.items) {
        let item = normalizeItem(
          raw,
          result.action,
          projectSimpleNames.get(raw.project_key.trim()),
        );
        if (!item) continue;
        const nodeIdentity = itemNodeIdentity(raw);
        const identities = nodeIdentities.get(item.key);
        const primaryNodeIdentity = identities?.values().next().value;
        if ((identities?.size ?? 0) > 1 && nodeIdentity !== primaryNodeIdentity) {
          item = { ...item, key: `${item.key}:node:${encodeURIComponent(nodeIdentity)}` };
        }
        if (result.action === "done") {
          const completed = item.completedAt ? new Date(item.completedAt).getTime() : Number.NaN;
          if (!Number.isFinite(completed) || completed < cutoff) continue;
        }
        const current = winners.get(item.key);
        if (!current || (current.source === "mywork"
          && actionPriority(result.action) > actionPriority(current.action))) {
          winners.set(item.key, { source: "mywork", action: result.action, item });
        }
      }
    }

    for (const result of createdResults) {
      if (result.outcome !== "success") continue;
      const scopeKey = createdScopeKey(result.project, result.workItemType);
      for (const raw of result.items) {
        const item = normalizeCreatedItem(raw, result.project, result.workItemType);
        if (!item || winners.has(item.key)) continue;
        winners.set(item.key, { source: "created", scopeKey, item });
      }
    }

    const projectsById = new Map<string, ProjectRef>();
    const myworkProjectIds = new Set([...winners.values()]
      .filter((winner) => winner.source === "mywork")
      .map((winner) => winner.item.projectExternalId));
    for (const { item } of winners.values()) {
      projectsById.set(item.projectExternalId, {
        providerId: this.id,
        externalId: item.projectExternalId,
        name: item.projectName,
        selected: true,
        available: true,
        source: "discovered",
        lastVerifiedAt: this.clock().toISOString(),
      });
    }
    for (const project of created.discoveredProjects) {
      if (projectsById.has(project.project_key)) continue;
      projectsById.set(project.project_key, {
        providerId: this.id,
        externalId: project.project_key,
        name: project.name,
        selected: true,
        available: true,
        source: "discovered",
        lastVerifiedAt: this.clock().toISOString(),
      });
    }
    const scopes: AccountWorkItemQueryResult["scopes"] = [];
    for (const result of results) {
      for (const kind of kinds) {
        const providerItemType = `mywork:${result.action}:${kind}`;
        if (result.outcome === "error") {
          const affectedProjects = projectsById.size > 0
            ? [...projectsById.keys()]
            : [`account:${result.action}`];
          for (const projectExternalId of affectedProjects) {
            scopes.push({
              projectExternalId,
              providerItemType,
              kind,
              outcome: "error",
              items: [],
              errorCode: result.errorCode,
            });
          }
          continue;
        }
        const items = [...winners.values()]
          .filter((winner) => winner.source === "mywork"
            && winner.action === result.action && winner.item.kind === kind)
          .map((winner) => winner.item)
          .sort((left, right) => left.projectName.localeCompare(right.projectName)
            || left.externalId.localeCompare(right.externalId));
        const byProject = new Map<string, WorkItem[]>();
        for (const item of items) {
          const projectItems = byProject.get(item.projectExternalId) ?? [];
          projectItems.push(item);
          byProject.set(item.projectExternalId, projectItems);
        }
        for (const project of projectsById.values()) {
          if (!myworkProjectIds.has(project.externalId)) continue;
          scopes.push({
            projectExternalId: project.externalId,
            providerItemType,
            kind,
            outcome: "success",
            items: byProject.get(project.externalId) ?? [],
          });
        }
      }
    }
    for (const result of createdResults) {
      if (result.outcome === "error") {
        scopes.push({
          projectExternalId: result.projectExternalId,
          providerItemType: result.providerItemType,
          kind: result.workItemType ? mapKind(result.workItemType.type_key) : "other",
          outcome: "error",
          items: [],
          errorCode: result.errorCode,
        });
        continue;
      }
      const scopeKey = createdScopeKey(result.project, result.workItemType);
      scopes.push({
        projectExternalId: result.project.project_key,
        providerItemType: `created:${result.workItemType.type_key}`,
        kind: mapKind(result.workItemType.type_key),
        outcome: "success",
        items: [...winners.values()]
          .filter((winner) => winner.source === "created" && winner.scopeKey === scopeKey)
          .map((winner) => winner.item)
          .sort((left, right) => left.externalId.localeCompare(right.externalId)),
      });
    }
    for (const projectExternalId of created.authoritativeProjectIds) {
      scopes.push({
        projectExternalId,
        providerItemType: "created:catalog",
        kind: "other",
        outcome: "success",
        items: [],
      });
    }
    return {
      projects: [...projectsById.values()].sort((left, right) =>
        left.name.localeCompare(right.name) || left.externalId.localeCompare(right.externalId)),
      scopes,
      ...(created.authoritativeProjectScopePrefixes.length > 0
        ? { authoritativeProjectScopePrefixes: created.authoritativeProjectScopePrefixes }
        : {}),
      authoritativeProviderItemTypes: results
        .filter((result) => result.outcome === "success")
        .flatMap((result) => kinds.map((kind) => `mywork:${result.action}:${kind}`)),
      authoritativeScopePrefixes: created.authoritativeProjectIds.map((projectExternalId) => ({
        projectExternalId,
        providerItemTypePrefix: "created:",
      })),
      ...(created.coverage.catalog !== "unavailable"
        ? { authoritativeScopeInventories: created.authoritativeScopeInventories }
        : {}),
      createdSyncCoverage: created.coverage,
    };
  }

  private async captureProfile() {
    try {
      return await this.client.getCurrentProfile();
    } catch (error) {
      throw new WorkItemProviderError(providerErrorCode(error));
    }
  }

  private async captureIdentity(profile: string) {
    try {
      return await this.client.getCurrentUser(profile);
    } catch (error) {
      throw new WorkItemProviderError(providerErrorCode(error));
    }
  }
}

function parseCreatedQuery(
  query: MeegleCreatedBaseQuery | MeegleCreatedCompletionQuery,
  completion: boolean,
): CreatedItemData[] {
  if (!query || typeof query !== "object") throw invalidCreatedResponse();
  if (query.list === null) {
    if (!query.data || Object.keys(query.data).length !== 0) throw invalidCreatedResponse();
    return [];
  }
  if (!Array.isArray(query.list) || query.list.length !== 1) throw invalidCreatedResponse();
  const summary = query.list[0];
  const rows = query.data?.["1"];
  if (!summary || !Array.isArray(rows)
    || summary.count !== rows.length || rows.length > createdPageSize) {
    throw invalidCreatedResponse();
  }
  const expectedKeys = completion
    ? ["finish_time", "name", "work_item_id", "work_item_status"]
    : ["name", "work_item_id", "work_item_status"];
  const parsed = rows.map((row) => {
    if (!row || typeof row !== "object" || !Array.isArray(row.moql_field_list)) {
      throw invalidCreatedResponse();
    }
    const fields = row.moql_field_list as Array<Record<string, unknown>>;
    const keys = fields.map((field) => field.key).sort();
    if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) {
      throw invalidCreatedResponse();
    }
    const byKey = new Map(fields.map((field) => [field.key, field]));
    const id = nestedValue(byKey.get("work_item_id"), "long_value");
    const title = nestedValue(byKey.get("name"), "string_value");
    const statusValues = nestedValue(byKey.get("work_item_status"), "key_label_value_list");
    const status = Array.isArray(statusValues) ? statusValues[0] : undefined;
    const statusKey = status && typeof status === "object" ? Reflect.get(status, "key") : undefined;
    const statusLabel = status && typeof status === "object" ? Reflect.get(status, "label") : undefined;
    if (!Number.isSafeInteger(id) || (id as number) < 0
      || typeof title !== "string" || !title.trim()
      || typeof statusKey !== "string" || !statusKey.trim()
      || typeof statusLabel !== "string" || !statusLabel.trim()) {
      throw invalidCreatedResponse();
    }
    const item: CreatedItemData = {
      externalId: String(id),
      title: title.trim(),
      statusKey: statusKey.trim(),
      statusLabel: statusLabel.trim(),
    };
    if (completion) {
      const field = byKey.get("finish_time");
      const value = field && typeof field === "object" ? Reflect.get(field, "value") : undefined;
      if (value !== null) {
        const finishTime = value && typeof value === "object"
          ? Reflect.get(value, "string_value")
          : undefined;
        if (typeof finishTime !== "string" || !finishTime) throw invalidCreatedResponse();
        item.finishTime = finishTime;
      }
    }
    return item;
  });
  if (new Set(parsed.map(({ externalId }) => externalId)).size !== parsed.length) {
    throw invalidCreatedResponse();
  }
  return parsed;
}

function nestedValue(field: unknown, key: string): unknown {
  if (!field || typeof field !== "object") return undefined;
  const value = Reflect.get(field, "value");
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function invalidCreatedResponse() {
  return new WorkItemProviderError("provider_unavailable");
}

function sameCreatedIds(left: CreatedItemData[], right: CreatedItemData[]) {
  if (left.length !== right.length) return false;
  const ids = new Set(left.map(({ externalId }) => externalId));
  return right.every(({ externalId }) => ids.has(externalId));
}

function createdScopeKey(project: MeegleProject, workItemType: MeegleWorkItemType) {
  return `${project.project_key}\0${workItemType.type_key}`;
}

function countDirectoryTypes(projects: CreatedDirectory["projects"]) {
  return new Set(projects.flatMap(({ project, workItemTypes }) =>
    workItemTypes.map((workItemType) => createdScopeKey(project, workItemType)))).size;
}

function normalizeCreatedItem(
  raw: CreatedItemData,
  project: MeegleProject,
  workItemType: MeegleWorkItemType,
): WorkItem | undefined {
  const { externalId, title, statusKey, statusLabel, finishTime } = raw;
  const projectExternalId = project.project_key.trim();
  const projectName = project.name.trim();
  const providerItemType = workItemType.type_key.trim();
  if (!externalId || !title || !statusKey || !statusLabel
    || !projectExternalId || !projectName || !providerItemType) {
    return undefined;
  }
  const stage = createdStage(raw);
  const completedAt = normalizedDate(finishTime);
  if (stage === "done" && !completedAt) return undefined;
  return {
    key: `feishu-project:${projectExternalId}:${providerItemType}:${externalId}`,
    providerId: "feishu-project",
    externalId,
    projectExternalId,
    projectName,
    kind: mapKind(providerItemType),
    providerItemType,
    title,
    stage,
    providerStatus: statusLabel,
    freshness: "fresh",
    ...(completedAt ? { completedAt } : {}),
    externalUrl: `https://project.feishu.cn/${encodeURIComponent(project.simple_name)}`
      + `/${encodeURIComponent(providerItemType)}/detail/${encodeURIComponent(externalId)}`,
  };
}

function collectNodeIdentities(results: ActionResult[]) {
  const identities = new Map<string, Set<string>>();
  for (const result of results) {
    if (result.outcome !== "success" || result.action === "done") continue;
    for (const raw of result.items) {
      const projectExternalId = raw.project_key.trim();
      const providerItemType = raw.work_item_info.work_item_type_key.trim();
      const externalId = String(raw.work_item_info.work_item_id).trim();
      const nodeIdentity = itemNodeIdentity(raw);
      if (!projectExternalId || !providerItemType || !externalId || !nodeIdentity) continue;
      const key = `feishu-project:${projectExternalId}:${providerItemType}:${externalId}`;
      const values = identities.get(key) ?? new Set<string>();
      values.add(nodeIdentity);
      identities.set(key, values);
    }
  }
  return identities;
}

function itemNodeIdentity(raw: RawItem) {
  return raw.node_info.node_state_key.trim() || raw.node_info.node_name.trim();
}

function normalizeItem(
  raw: RawItem,
  action: MeegleMyWorkAction,
  projectSimpleName?: string,
): WorkItem | undefined {
  const projectExternalId = raw.project_key.trim();
  const projectName = raw.project_name.trim();
  const externalId = String(raw.work_item_info.work_item_id).trim();
  const title = raw.work_item_info.work_item_name.trim();
  const providerItemType = raw.work_item_info.work_item_type_key.trim();
  if (!projectExternalId || !projectName || !externalId || !title || !providerItemType) {
    return undefined;
  }
  const kind = mapKind(providerItemType);
  const providerState = raw.node_info.node_state_key || raw.node_info.node_name
    || raw.state_info.end_state_key_name || raw.state_info.start_state_key_name || "unknown";
  const item: WorkItem = {
    key: `feishu-project:${projectExternalId}:${providerItemType}:${externalId}`,
    providerId: "feishu-project",
    externalId,
    projectExternalId,
    projectName,
    kind,
    providerItemType,
    title,
    stage: mapStage(action, providerState),
    providerStatus: action === "overdue" ? `overdue:${providerState}` : providerState,
    freshness: "fresh",
  };
  const completedAt = normalizedDate(raw.finish_time?.finish_time);
  if (completedAt) item.completedAt = completedAt;
  const dueAt = normalizedScheduleEnd(raw.schedule);
  if (dueAt) item.dueAt = dueAt;
  if (projectSimpleName) {
    item.externalUrl = `https://project.feishu.cn/${encodeURIComponent(projectSimpleName)}`
      + `/${encodeURIComponent(providerItemType)}/detail/${encodeURIComponent(externalId)}`;
  }
  return item;
}

function mapKind(type: string): WorkItemKind {
  const normalized = type.toLowerCase();
  if (["story", "requirement", "需求"].includes(normalized)) return "requirement";
  if (["task", "任务"].includes(normalized)) return "task";
  if (["bug", "defect", "缺陷"].includes(normalized)) return "defect";
  return "other";
}

function mapStage(action: MeegleMyWorkAction, state: string): CanonicalStage {
  if (action === "done") return "done";
  return mapStateStage(state);
}

const createdTerminalStatuses = new Set([
  "done",
  "closed",
  "complete",
  "completed",
  "finish",
  "finished",
  "已完成",
  "已关闭",
]);

function createdStage(item: Pick<CreatedItemData, "statusKey" | "statusLabel">): CanonicalStage {
  const statusKey = normalizedStatusToken(item.statusKey);
  const statusLabel = normalizedStatusToken(item.statusLabel);
  if (createdTerminalStatuses.has(statusKey) || createdTerminalStatuses.has(statusLabel)) {
    return "done";
  }
  const stage = mapStateStage(`${item.statusKey} ${item.statusLabel}`);
  return stage === "done" ? "todo" : stage;
}

function normalizedStatusToken(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

function mapStateStage(state: string): CanonicalStage {
  const normalized = state.toLowerCase();
  if (/(done|closed|complete|finish|已完成|已关闭)/u.test(normalized)) return "done";
  if (/(review|test|verify|验收|评审|测试)/u.test(normalized)) return "in_review";
  if (/(not[_ -]?started|未开始|待处理|待办)/u.test(normalized)) return "todo";
  if (/(progress|doing|started|develop|进行|处理|开发)/u.test(normalized)) return "in_progress";
  return "todo";
}

function normalizedDate(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizedScheduleEnd(value: unknown) {
  const schedule = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(schedule) || schedule.length < 2) return undefined;
  const end = schedule[1];
  const timestamp = typeof end === "number"
    ? end
    : typeof end === "string" && /^\d+$/u.test(end)
      ? Number(end)
      : Number.NaN;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function actionPriority(action: MeegleMyWorkAction) {
  return action === "overdue" ? 4 : action === "this_week" ? 3 : action === "todo" ? 2 : 1;
}

function providerErrorCode(error: unknown): WorkItemErrorCode {
  if (error instanceof WorkItemProviderError) return error.code;
  if (error instanceof MeegleCliError) {
    if (error.code === "provider_unauthorized") return "provider_unauthorized";
    return "provider_unavailable";
  }
  return "work_item_sync_failed";
}

function isProviderCancelled(error: unknown): error is MeegleCliError {
  return error instanceof MeegleCliError && error.code === "provider_cancelled";
}
