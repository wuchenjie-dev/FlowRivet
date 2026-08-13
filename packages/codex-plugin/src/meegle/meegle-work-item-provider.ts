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
  MeegleMyWorkPage,
  MeegleUser,
} from "./meegle-cli-contracts.js";
import {
  MeegleCliError,
  type MeegleMyWorkAction,
} from "./meegle-cli-client.js";

export interface MeegleWorkItemClient {
  getCurrentProfile(): Promise<string>;
  getCurrentUser(profile: string): Promise<MeegleUser>;
  getProjectSimpleName(profile: string, projectKey: string): Promise<string | undefined>;
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

const actions: MeegleMyWorkAction[] = ["todo", "this_week", "overdue", "done"];
const kinds: WorkItemKind[] = ["requirement", "task", "defect", "other"];
const pageSize = 50;
const maximumPages = 1_000;
const maximumItems = 50_000;

export class MeegleWorkItemProvider implements AccountScopedWorkItemProvider {
  readonly id = "feishu-project";
  readonly queryMode = "account_scoped" as const;

  private readonly client: MeegleWorkItemClient;
  private readonly clock: () => Date;

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

    const results = await this.fetchActions(profile);

    const projectSimpleNames = await this.resolveProjectSimpleNames(profile, results);
    const afterProfile = await this.captureProfile();
    const after = await this.captureIdentity(profile);
    if (afterProfile !== profile || after.user_key !== before.user_key) {
      throw new WorkItemProviderError("provider_unauthorized");
    }
    return this.normalize(results, projectSimpleNames);
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
      reportedTotal = result.total;
      const pageItems = result.list ?? [];
      if (items.length + pageItems.length > maximumItems
        || items.length + pageItems.length > result.total) {
        throw new WorkItemProviderError("provider_unavailable");
      }
      items.push(...pageItems);
      if (result.list === null || pageItems.length < pageSize) {
        if (items.length !== result.total) {
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

  private async resolveProjectSimpleNames(profile: string, results: ActionResult[]) {
    const projectKeys = new Set<string>();
    for (const result of results) {
      if (result.outcome !== "success") continue;
      for (const item of result.items) {
        const projectKey = item.project_key.trim();
        if (projectKey) projectKeys.add(projectKey);
      }
    }

    const simpleNames = new Map<string, string>();
    for (const projectKey of projectKeys) {
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
    projectSimpleNames: ReadonlyMap<string, string>,
  ): AccountWorkItemQueryResult {
    const cutoff = this.clock().getTime() - 7 * 24 * 60 * 60 * 1_000;
    const nodeIdentities = collectNodeIdentities(results);
    const winners = new Map<string, { action: MeegleMyWorkAction; item: WorkItem }>();
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
        if (!current || actionPriority(result.action) > actionPriority(current.action)) {
          winners.set(item.key, { action: result.action, item });
        }
      }
    }

    const projectsById = new Map<string, ProjectRef>();
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
          .filter((winner) => winner.action === result.action && winner.item.kind === kind)
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
    return {
      projects: [...projectsById.values()].sort((left, right) =>
        left.name.localeCompare(right.name) || left.externalId.localeCompare(right.externalId)),
      scopes,
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
