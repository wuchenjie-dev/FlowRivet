import type {
  CanonicalStage,
  WorkItem,
} from "../contracts/taskboard.js";
import type { TapdProjectCredentialResolver } from "../projects/tapd-project-provider.js";
import {
  WorkItemProviderError,
  type WorkItemErrorCode,
  type WorkItemProvider,
  type WorkItemQueryResult,
} from "./work-item-provider.js";

type TapdItemKind = "requirement" | "task" | "defect";

const itemQueries: Array<{
  kind: TapdItemKind;
  path: string;
  ownerParameter: "owner" | "current_owner";
  wrapper: "Story" | "Task" | "Bug";
  providerItemType: "story" | "task" | "bug";
}> = [
  { kind: "requirement", path: "/stories", ownerParameter: "owner", wrapper: "Story", providerItemType: "story" },
  { kind: "task", path: "/tasks", ownerParameter: "owner", wrapper: "Task", providerItemType: "task" },
  { kind: "defect", path: "/bugs", ownerParameter: "current_owner", wrapper: "Bug", providerItemType: "bug" },
];

export class TapdWorkItemProvider implements WorkItemProvider {
  readonly id = "tapd";

  private readonly endpoint: string;
  private readonly credentialResolver: TapdProjectCredentialResolver;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => Date;

  constructor(options: {
    credentialResolver: TapdProjectCredentialResolver;
    endpoint?: string;
    fetcher?: typeof fetch;
    clock?: () => Date;
  }) {
    this.credentialResolver = options.credentialResolver;
    this.endpoint = (options.endpoint ?? "https://api.tapd.cn").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  async listProjectWorkItems(input: {
    projectExternalId: string;
    projectName: string;
    accountDisplayName: string;
  }): Promise<WorkItemQueryResult> {
    let token: string;
    try {
      ({ token } = await this.credentialResolver.resolve());
    } catch (error) {
      const errorCode = providerErrorCode(error);
      return {
        projectExternalId: input.projectExternalId,
        scopes: itemQueries.map((query) => failedScope(query, errorCode)),
      };
    }

    const scopes: WorkItemQueryResult["scopes"] = [];
    let terminalError: WorkItemProviderError | undefined;

    for (const query of itemQueries) {
      if (terminalError) {
        scopes.push(failedScope(
          query,
          terminalError.code,
          terminalError.retryAfterSeconds,
        ));
        continue;
      }
      try {
        const rows = await this.listRows(
          query.path,
          query.ownerParameter,
          input.projectExternalId,
          input.accountDisplayName,
          token,
        );
        const items = rows.flatMap((row) => {
          const item = mapItem(row, query.kind, query.wrapper, input);
          return item ? [item] : [];
        });
        scopes.push({
          providerItemType: query.providerItemType,
          kind: query.kind,
          outcome: "success",
          items,
        });
      } catch (error) {
        const errorCode = providerErrorCode(error);
        const retryAfterSeconds = error instanceof WorkItemProviderError
          ? error.retryAfterSeconds
          : undefined;
        scopes.push(failedScope(query, errorCode, retryAfterSeconds));
        if (error instanceof WorkItemProviderError
          && (errorCode === "provider_unauthorized"
            || errorCode === "provider_rate_limited")) {
          terminalError = error;
        }
      }
    }

    return { projectExternalId: input.projectExternalId, scopes };
  }

  private async listRows(
    path: string,
    ownerParameter: "owner" | "current_owner",
    workspaceId: string,
    owner: string,
    token: string,
  ): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const url = new URL(`${this.endpoint}${path}`);
      url.searchParams.set("workspace_id", workspaceId);
      url.searchParams.set(ownerParameter, owner);
      url.searchParams.set("limit", "200");
      url.searchParams.set("page", String(page));
      const current = await this.request(url, token);
      rows.push(...current);
      if (current.length < 200) break;
    }
    return rows;
  }

  private async request(url: URL, token: string): Promise<unknown[]> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new WorkItemProviderError("provider_unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new WorkItemProviderError("provider_unauthorized");
    }
    if (response.status === 429) {
      throw new WorkItemProviderError("provider_rate_limited", {
        retryAfterSeconds: parseRetryAfter(
          response.headers.get("retry-after"),
          this.clock(),
        ),
      });
    }
    if (!response.ok) throw new WorkItemProviderError("work_item_sync_failed");

    let payload: Record<string, unknown>;
    try {
      payload = asRecord(await response.json());
    } catch {
      throw new WorkItemProviderError("work_item_sync_failed");
    }
    if (Number(payload.status) !== 1 || !Array.isArray(payload.data)) {
      throw new WorkItemProviderError("work_item_sync_failed");
    }
    return payload.data;
  }
}

function failedScope(
  query: (typeof itemQueries)[number],
  errorCode: WorkItemErrorCode,
  retryAfterSeconds?: number,
): WorkItemQueryResult["scopes"][number] {
  return {
    providerItemType: query.providerItemType,
    kind: query.kind,
    outcome: "error",
    items: [],
    errorCode,
    ...(errorCode === "provider_rate_limited" && retryAfterSeconds !== undefined
      ? { retryAfterSeconds }
      : {}),
  };
}

function parseRetryAfter(value: string | null, now: Date) {
  const trimmed = value?.trim();
  let seconds: number;
  if (trimmed && /^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else if (trimmed) {
    seconds = Math.ceil((Date.parse(trimmed) - now.getTime()) / 1000);
  } else {
    seconds = Number.NaN;
  }
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400
    ? seconds
    : 60;
}

function providerErrorCode(error: unknown): WorkItemErrorCode {
  if (error instanceof WorkItemProviderError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (code === "provider_unauthorized") return code;
    if (code === "provider_unavailable" || code === "provider_not_connected") {
      return "provider_unavailable";
    }
  }
  return "work_item_sync_failed";
}

function mapItem(
  value: unknown,
  kind: TapdItemKind,
  wrapperName: "Story" | "Task" | "Bug",
  project: { projectExternalId: string; projectName: string; accountDisplayName: string },
): WorkItem | undefined {
  const wrapper = asRecord(value);
  const row = asRecord(wrapper[wrapperName] ?? value);
  const externalId = scalarString(row.id);
  const title = scalarString(row.name ?? row.title);
  const providerStatus = scalarString(row.status);
  const owner = scalarString(kind === "defect" ? row.current_owner : row.owner);
  if (!externalId || !title || !providerStatus || !owner
    || !hasExactMember(owner, project.accountDisplayName)) return undefined;

  const item: WorkItem = {
    key: `tapd:${project.projectExternalId}:${kind}:${externalId}`,
    providerId: "tapd",
    externalId,
    projectExternalId: project.projectExternalId,
    projectName: project.projectName,
    kind,
    providerItemType: kind === "requirement" ? "story" : kind === "defect" ? "bug" : "task",
    title,
    stage: mapStage(kind, providerStatus),
    providerStatus,
    freshness: "fresh",
    externalUrl: itemUrl(project.projectExternalId, kind, externalId),
  };
  const priority = scalarString(row.priority);
  const dueAt = normalizedDate(row.due ?? row.due_date);
  const completedAt = normalizedDate(kind === "defect"
    ? row.closed ?? row.resolved
    : row.completed);
  if (priority) item.priority = priority;
  if (dueAt) item.dueAt = dueAt;
  if (completedAt) item.completedAt = completedAt;
  return item;
}

function mapStage(kind: TapdItemKind, status: string): CanonicalStage {
  const normalized = status.trim().toLowerCase();
  if (kind === "task") {
    if (["done", "closed", "completed", "已完成"].includes(normalized)) return "done";
    if (["progressing", "in_progress", "进行中", "处理中"].includes(normalized)) {
      return "in_progress";
    }
    return "todo";
  }
  if (kind === "defect") {
    if (["closed", "已关闭"].includes(normalized)) return "done";
    if (["resolved", "verified", "testing", "已解决", "待验证", "测试中"].includes(normalized)) {
      return "in_review";
    }
    if (["accepted", "in_progress", "progressing", "reopened", "处理中", "重新打开"].includes(normalized)) {
      return "in_progress";
    }
    return "todo";
  }
  if (["done", "closed", "completed", "已完成", "已关闭"].includes(normalized)) return "done";
  if (["reviewing", "testing", "in_review", "评审中", "测试中"].includes(normalized)) {
    return "in_review";
  }
  if (["progressing", "in_progress", "developing", "实现中", "进行中"].includes(normalized)) {
    return "in_progress";
  }
  return "todo";
}

function itemUrl(workspaceId: string, kind: TapdItemKind, externalId: string) {
  if (kind === "defect") {
    return `https://www.tapd.cn/${workspaceId}/bugtrace/bugs/view/${externalId}`;
  }
  const segment = kind === "requirement" ? "stories" : "tasks";
  return `https://www.tapd.cn/${workspaceId}/prong/${segment}/view/${externalId}`;
}

function hasExactMember(value: string, expected: string) {
  return value.split(";").map((member) => member.trim()).includes(expected.trim());
}

function normalizedDate(value: unknown) {
  const raw = scalarString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function scalarString(value: unknown) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}
