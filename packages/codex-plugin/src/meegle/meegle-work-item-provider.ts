import type { ProjectRef } from "../contracts/projects.js";
import type {
  CanonicalStage,
  WorkItem,
  WorkItemKind,
} from "../contracts/taskboard.js";
import {
  WorkItemProviderError,
  type AccountScopedWorkItemProvider,
  type AccountWorkItemQueryResult,
  type WorkItemErrorCode,
} from "../work-items/work-item-provider.js";
import type {
  MeegleCreatedWorkItemQuery,
  MeegleMyWorkPage,
  MeegleProject,
  MeegleUser,
  MeegleWorkItemType,
} from "./meegle-cli-contracts.js";
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
  queryCreatedWorkItems(
    profile: string, project: MeegleProject, workItemType: MeegleWorkItemType,
  ): Promise<MeegleCreatedWorkItemQuery>;
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
type NonEmptyCreatedQuery = Extract<MeegleCreatedWorkItemQuery, { list: unknown[] }>;
type CreatedRow = NonEmptyCreatedQuery["data"]["1"][number];
type CreatedResult =
  | {
    outcome: "success";
    project: MeegleProject;
    workItemType: MeegleWorkItemType;
    items: CreatedRow[];
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
interface CreatedFetchResult {
  authoritativeProjectScopePrefixes: string[];
  discoveredProjects: MeegleProject[];
  authoritativeProjectIds: string[];
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
// Bounds every automatic refresh while covering the observed 18-type recent project.
const maximumCreatedTypeQueriesPerSync = 40;

export class MeegleWorkItemProvider implements AccountScopedWorkItemProvider {
  readonly id = "feishu-project";
  readonly queryMode = "account_scoped" as const;

  private readonly client: MeegleWorkItemClient;
  private readonly clock: () => Date;
  private directoryCache?: {
    identityKey: string;
    expiresAt: number;
    discoveredProjects: MeegleProject[];
    successfulTypes: Map<string, MeegleWorkItemType[]>;
  };

  constructor(options: { client: MeegleWorkItemClient; clock?: () => Date }) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date());
  }

  async listAccountWorkItems(input: {
    accountDisplayName: string;
    accountKey?: string;
    tenantKey?: string;
    syncSessionKey?: string;
  }): Promise<AccountWorkItemQueryResult> {
    const profile = await this.captureProfile();
    if (input.syncSessionKey && input.syncSessionKey !== profile) {
      throw new WorkItemProviderError("provider_unauthorized");
    }
    const before = await this.captureIdentity(profile);
    if (input.accountKey && input.accountKey !== before.user_key) {
      throw new WorkItemProviderError("provider_unauthorized");
    }

    const [results, created] = await Promise.all([
      this.fetchActions(profile),
      this.fetchCreated(profile, before.user_key),
    ]);

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
    return this.normalize(results, created, projectSimpleNames);
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

  private async fetchCreated(profile: string, userKey: string): Promise<CreatedFetchResult> {
    let directory: CreatedDirectory;
    try {
      directory = await this.getCreatedDirectory(profile, userKey);
    } catch (error) {
      return {
        authoritativeProjectScopePrefixes: [],
        discoveredProjects: [],
        authoritativeProjectIds: [],
        results: [{
          outcome: "error",
          projectExternalId: "account:created",
          providerItemType: "created:catalog",
          errorCode: providerErrorCode(error),
        }],
      };
    }

    const results: CreatedResult[] = [...directory.errors];
    let reportedCreatedCount = 0;
    const reserveCreatedCount = (count: number) => {
      reportedCreatedCount += count;
      if (reportedCreatedCount > maximumCreatedItems) {
        throw new WorkItemProviderError("provider_unavailable");
      }
    };
    let claimedQueries = 0;
    for (const entry of directory.projects) {
      const requests = entry.workItemTypes.map((workItemType) => ({
        project: entry.project,
        workItemType,
      }));
      if (claimedQueries + requests.length > maximumCreatedTypeQueriesPerSync) {
        results.push(...requests.map((request): CreatedResult => ({
          outcome: "error",
          ...request,
          projectExternalId: request.project.project_key,
          providerItemType: `created:${request.workItemType.type_key}`,
          errorCode: "provider_unavailable",
        })));
        continue;
      }
      claimedQueries += requests.length;
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < requests.length) {
          const request = requests[nextIndex++];
          if (!request) return;
          try {
            const items = await this.fetchCreatedType(
              profile, request.project, request.workItemType, reserveCreatedCount,
            );
            results.push({ outcome: "success", ...request, items });
          } catch (error) {
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
    }
    return {
      authoritativeProjectScopePrefixes: ["created:"],
      discoveredProjects: directory.discoveredProjects,
      authoritativeProjectIds: directory.projects.map(({ project }) => project.project_key),
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
    const worker = async () => {
      while (nextIndex < recentProjects.length) {
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
  ): Promise<CreatedRow[]> {
    const first = await this.client.queryCreatedWorkItems(profile, project, workItemType);
    if (first.list === null) {
      reserveCount(0);
      return [];
    }
    const group = createdGroup(first);
    if (group.count > createdPageSize) {
      throw new WorkItemProviderError("provider_unavailable");
    }
    reserveCount(group.count);
    const items = [...createdRows(first, group.groupId)];
    if (items.length !== group.count || items.length > createdPageSize) {
      throw new WorkItemProviderError("provider_unavailable");
    }
    return items;
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

function createdGroup(query: NonEmptyCreatedQuery) {
  const group = query.list[0].group_infos[0];
  return { count: query.list[0].count, groupId: group.group_id };
}

function createdRows(query: NonEmptyCreatedQuery, groupId: "1") {
  return query.data[groupId];
}

function createdScopeKey(project: MeegleProject, workItemType: MeegleWorkItemType) {
  return `${project.project_key}\0${workItemType.type_key}`;
}

function normalizeCreatedItem(
  raw: CreatedRow,
  project: MeegleProject,
  workItemType: MeegleWorkItemType,
): WorkItem | undefined {
  let externalId = "";
  let title = "";
  let statusKey = "";
  let statusLabel = "";
  let finishTime: string | undefined;
  for (const field of raw.moql_field_list) {
    if (field.key === "work_item_id") externalId = String(field.value.long_value);
    if (field.key === "name") title = field.value.string_value.trim();
    if (field.key === "work_item_status") {
      statusKey = field.value.key_label_value_list[0]?.key.trim() ?? "";
      statusLabel = field.value.key_label_value_list[0]?.label.trim() ?? "";
    }
    if (field.key === "finish_time") finishTime = field.value?.string_value;
  }
  const projectExternalId = project.project_key.trim();
  const projectName = project.name.trim();
  const providerItemType = workItemType.type_key.trim();
  if (!externalId || !title || !statusKey || !statusLabel
    || !projectExternalId || !projectName || !providerItemType) {
    return undefined;
  }
  const stage = mapStateStage(`${statusKey} ${statusLabel}`);
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
