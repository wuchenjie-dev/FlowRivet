import type {
  ProviderWorkItemType,
  WorkItemDetail,
} from "../contracts/work-item-detail.js";
import type { WorkItemKind } from "../contracts/taskboard.js";
import type { TapdProjectCredentialResolver } from "../projects/tapd-project-provider.js";
import { sanitizeDescription } from "./sanitize-description.js";
import {
  WorkItemDetailProviderError,
  type WorkItemDetailErrorCode,
  type WorkItemDetailProvider,
} from "./work-item-detail-provider.js";

const queryByType: Record<ProviderWorkItemType, {
  path: string;
  wrapper: "Story" | "Task" | "Bug";
  kind: Exclude<WorkItemKind, "other">;
}> = {
  story: { path: "/stories", wrapper: "Story", kind: "requirement" },
  task: { path: "/tasks", wrapper: "Task", kind: "task" },
  bug: { path: "/bugs", wrapper: "Bug", kind: "defect" },
};

export class TapdWorkItemDetailProvider implements WorkItemDetailProvider {
  readonly id = "tapd";

  private readonly endpoint: string;
  private readonly credentialResolver: TapdProjectCredentialResolver;
  private readonly fetcher: typeof fetch;

  constructor(options: {
    credentialResolver: TapdProjectCredentialResolver;
    endpoint?: string;
    fetcher?: typeof fetch;
  }) {
    this.credentialResolver = options.credentialResolver;
    this.endpoint = (options.endpoint ?? "https://api.tapd.cn").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async getWorkItemDetail(
    input: Parameters<WorkItemDetailProvider["getWorkItemDetail"]>[0],
  ): Promise<WorkItemDetail> {
    const query = queryByType[input.reference.providerItemType];
    if (!query) {
      throw new WorkItemDetailProviderError("work_item_detail_unsupported");
    }
    const token = await this.resolveToken();
    const url = new URL(`${this.endpoint}${query.path}`);
    url.searchParams.set("workspace_id", input.reference.projectExternalId);
    url.searchParams.set("id", input.reference.externalId);
    url.searchParams.set("limit", "1");
    const rows = await this.request(url, token);
    if (rows.length === 0) {
      throw new WorkItemDetailProviderError("work_item_detail_not_found");
    }

    const row = rows
      .map((value) => {
        const wrapper = asRecord(value);
        return asRecord(wrapper[query.wrapper] ?? value);
      })
      .find((candidate) =>
        scalarString(candidate.id) === input.reference.externalId
        && scalarString(candidate.workspace_id) === input.reference.projectExternalId);
    if (!row) {
      throw new WorkItemDetailProviderError("work_item_detail_not_found");
    }

    const title = scalarString(row.name ?? row.title);
    const providerStatus = scalarString(row.status);
    const owner = scalarString(query.kind === "defect" ? row.current_owner : row.owner);
    if (!title || !providerStatus || !owner) {
      throw new WorkItemDetailProviderError("work_item_detail_invalid_response");
    }
    const assignees = members(owner);
    if (!assignees.includes(input.accountDisplayName.trim())) {
      throw new WorkItemDetailProviderError("work_item_detail_forbidden");
    }

    const description = sanitizeDescription(scalarString(row.description) ?? "");
    const detail: WorkItemDetail = {
      key: `tapd:${input.reference.projectExternalId}:${query.kind}:${input.reference.externalId}`,
      ...input.reference,
      projectName: input.projectName,
      kind: query.kind,
      title,
      providerStatus,
      assignees,
      descriptionTruncated: description.truncated,
      externalUrl: itemUrl(
        input.reference.projectExternalId,
        input.reference.providerItemType,
        input.reference.externalId,
      ),
    };
    const priority = scalarString(row.priority_label ?? row.priority);
    const creator = scalarString(query.kind === "defect" ? row.reporter ?? row.creator : row.creator);
    const createdAt = normalizedDate(row.created);
    const updatedAt = normalizedDate(row.modified);
    const dueAt = normalizedDate(query.kind === "defect" ? row.deadline : row.due ?? row.due_date);
    const completedAt = normalizedDate(query.kind === "defect"
      ? row.closed ?? row.resolved
      : row.completed);
    if (priority) detail.priority = priority;
    if (creator) detail.creator = creator;
    if (createdAt) detail.createdAt = createdAt;
    if (updatedAt) detail.updatedAt = updatedAt;
    if (dueAt) detail.dueAt = dueAt;
    if (completedAt) detail.completedAt = completedAt;
    if (description.html) detail.sanitizedDescriptionHtml = description.html;
    return detail;
  }

  private async resolveToken() {
    try {
      return (await this.credentialResolver.resolve()).token;
    } catch (error) {
      throw new WorkItemDetailProviderError(credentialErrorCode(error));
    }
  }

  private async request(url: URL, token: string): Promise<unknown[]> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new WorkItemDetailProviderError("provider_unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new WorkItemDetailProviderError("provider_unauthorized");
    }
    if (response.status === 404) {
      throw new WorkItemDetailProviderError("work_item_detail_not_found");
    }
    if (!response.ok) {
      throw new WorkItemDetailProviderError("provider_unavailable");
    }

    let payload: Record<string, unknown>;
    try {
      payload = asRecord(await response.json());
    } catch {
      throw new WorkItemDetailProviderError("work_item_detail_invalid_response");
    }
    if (Number(payload.status) !== 1 || !Array.isArray(payload.data)) {
      throw new WorkItemDetailProviderError("work_item_detail_invalid_response");
    }
    return payload.data;
  }
}

function credentialErrorCode(error: unknown): WorkItemDetailErrorCode {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  if (code === "provider_not_connected"
    || code === "provider_unauthorized"
    || code === "provider_unavailable") return code;
  return "provider_unavailable";
}

function itemUrl(workspaceId: string, type: ProviderWorkItemType, externalId: string) {
  if (type === "bug") {
    return `https://www.tapd.cn/${workspaceId}/bugtrace/bugs/view/${externalId}`;
  }
  const segment = type === "story" ? "stories" : "tasks";
  return `https://www.tapd.cn/${workspaceId}/prong/${segment}/view/${externalId}`;
}

function members(value: string) {
  return value.split(/[;,]/).map((member) => member.trim()).filter(Boolean);
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
