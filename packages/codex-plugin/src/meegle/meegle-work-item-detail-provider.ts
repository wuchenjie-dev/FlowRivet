import type { WorkItemKind } from "../contracts/taskboard.js";
import type { MeegleWorkItemDetail } from "./meegle-cli-contracts.js";
import { MeegleCliError } from "./meegle-cli-client.js";
import { sanitizeDescription } from "../work-items/sanitize-description.js";
import {
  WorkItemDetailProviderError,
  type WorkItemDetailProvider,
} from "../work-items/work-item-detail-provider.js";

export interface MeegleWorkItemDetailClient {
  getCurrentProfile(): Promise<string>;
  getWorkItem(profile: string, projectKey: string, workItemId: string): Promise<MeegleWorkItemDetail>;
}

export class MeegleWorkItemDetailProvider implements WorkItemDetailProvider {
  readonly id = "feishu-project";
  constructor(private readonly options: { client: MeegleWorkItemDetailClient }) {}

  async getWorkItemDetail(input: Parameters<WorkItemDetailProvider["getWorkItemDetail"]>[0]) {
    try {
      const profile = await this.options.client.getCurrentProfile();
      const raw = await this.options.client.getWorkItem(
        profile,
        input.reference.projectExternalId,
        input.reference.externalId,
      );
      return normalizeDetail(raw, input);
    } catch (error) {
      if (error instanceof WorkItemDetailProviderError) throw error;
      if (error instanceof MeegleCliError) {
        throw new WorkItemDetailProviderError(mapCliError(error));
      }
      throw new WorkItemDetailProviderError("provider_unavailable");
    }
  }
}

function normalizeDetail(
  raw: MeegleWorkItemDetail,
  input: Parameters<WorkItemDetailProvider["getWorkItemDetail"]>[0],
) {
  const attribute = raw.work_item_attribute;
  const reference = input.reference;
  if (String(attribute.work_item_id) !== reference.externalId
    || attribute.owned_project.key !== reference.projectExternalId
    || attribute.work_item_type.key !== reference.providerItemType) {
    throw new WorkItemDetailProviderError("work_item_detail_invalid_response");
  }
  const fields = new Map(raw.work_item_fields.map((field) => [field.key, field.value]));
  const description = sanitizeDescription(fields.get("description") ?? "");
  const externalUrl = `https://project.feishu.cn/${encodeURIComponent(attribute.owned_project.simple_name)}`
    + `/${encodeURIComponent(attribute.work_item_type.key)}/detail/${encodeURIComponent(reference.externalId)}`;
  return {
    ...reference,
    key: `feishu-project:${reference.projectExternalId}:${reference.providerItemType}:${reference.externalId}`,
    projectName: attribute.owned_project.name,
    kind: mapKind(attribute.work_item_type.key),
    title: attribute.work_item_name,
    providerStatus: attribute.work_item_status.name,
    ...(fieldLabel(fields.get("priority")) ? { priority: fieldLabel(fields.get("priority")) } : {}),
    assignees: people(fields.get("current_status_operator")),
    creator: attribute.create_by.name,
    ...(date(attribute.create_time) ? { createdAt: date(attribute.create_time) } : {}),
    ...(date(attribute.update_time) ? { updatedAt: date(attribute.update_time) } : {}),
    ...(date(fields.get("start_time")) ? { startedAt: date(fields.get("start_time")) } : {}),
    ...(date(fields.get("due_time")) ? { dueAt: date(fields.get("due_time")) } : {}),
    ...(date(fields.get("finish_time")) ? { completedAt: date(fields.get("finish_time")) } : {}),
    ...(description.html ? { sanitizedDescriptionHtml: description.html } : {}),
    descriptionTruncated: description.truncated,
    externalUrl,
  };
}

function fieldLabel(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && "label" in parsed
      && typeof parsed.label === "string" && parsed.label.trim()) return parsed.label.trim();
  } catch { /* scalar field */ }
  return value.trim() || undefined;
}

function people(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((person) => person && typeof person === "object"
      && "name" in person && typeof person.name === "string" && person.name.trim()
      ? [person.name.trim()] : []);
  } catch { return []; }
}

function date(value: string | null | undefined) {
  if (!value) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function mapKind(type: string): WorkItemKind {
  const normalized = type.toLowerCase();
  if (["story", "requirement"].includes(normalized)) return "requirement";
  if (["task"].includes(normalized)) return "task";
  if (["bug", "defect", "issue"].includes(normalized)) return "defect";
  return "other";
}

function mapCliError(error: MeegleCliError) {
  if (error.code === "provider_unauthorized") return "provider_unauthorized" as const;
  if (error.code === "provider_invalid_response") return "work_item_detail_invalid_response" as const;
  return "provider_unavailable" as const;
}
