import type { CustomField, FieldAdmin, FieldDefinition } from "./fields.js";
import type { PocStoryAdmin, PocStoryInput } from "../poc/seed.js";
import type { Requirement } from "../domain/requirement.js";
import type { RequirementReader } from "./read-client.js";
import { buildFieldMapping, mapTapdStory } from "./mapper.js";

interface AdminClientOptions {
  endpoint: string;
  workspaceId: string;
  apiUser: string;
  apiPassword: string;
  fetcher?: typeof fetch;
}

interface TapdResponse<T> {
  status: number;
  data: T;
  info: string;
}

interface TapdCustomFieldConfig {
  name: string;
  type: string;
  options?: string | null;
  custom_field: string;
  enabled: string;
}

export class TapdClient implements FieldAdmin, PocStoryAdmin, RequirementReader {
  private constructor(
    private readonly endpoint: string,
    private readonly workspaceId: string,
    private readonly authorization: string,
    private readonly fetcher: typeof fetch,
  ) {}

  static forAdmin(options: AdminClientOptions): TapdClient {
    const credentials = Buffer.from(
      `${options.apiUser}:${options.apiPassword}`,
      "utf8",
    ).toString("base64");
    return new TapdClient(
      options.endpoint.replace(/\/$/, ""),
      options.workspaceId,
      `Basic ${credentials}`,
      options.fetcher ?? fetch,
    );
  }

  async listCustomFields(): Promise<CustomField[]> {
    const response = await this.request<
      Array<TapdCustomFieldConfig | { CustomFieldConfig: TapdCustomFieldConfig }>
    >(`/stories/custom_fields_settings?workspace_id=${this.workspaceId}`);

    return response.map((entry) => {
      const config = "CustomFieldConfig" in entry ? entry.CustomFieldConfig : entry;
      return {
        name: config.name,
        type: config.type,
        options: parseOptions(config.options),
        field: config.custom_field,
        enabled: config.enabled === "1",
      };
    });
  }

  async createCustomField(field: FieldDefinition): Promise<CustomField> {
    const body = new URLSearchParams({
      workspace_id: this.workspaceId,
      entry_type: "story",
      name: field.name,
      type: field.type,
      memo: field.memo,
    });
    if (field.options) body.set("option", field.options.join("|"));

    const data = await this.request<{ CustomFieldConfig: TapdCustomFieldConfig }>(
      "/custom_field_configs",
      { method: "POST", body },
    );
    const config = data.CustomFieldConfig;
    return {
      name: config.name,
      type: config.type,
      options: parseOptions(config.options),
      field: config.custom_field,
      enabled: config.enabled === "1",
    };
  }

  async findStoryByExactTitle(title: string): Promise<{ id: string } | undefined> {
    const query = new URLSearchParams({
      workspace_id: this.workspaceId,
      name: title,
      limit: "200",
    });
    const data = await this.request<unknown[]>(`/stories?${query.toString()}`);
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const story =
        record.Story && typeof record.Story === "object"
          ? (record.Story as Record<string, unknown>)
          : record;
      if (story.name === title && story.id) return { id: String(story.id) };
    }
    return undefined;
  }

  async createStory(input: PocStoryInput): Promise<{ id: string }> {
    const body = new URLSearchParams({
      workspace_id: this.workspaceId,
      name: input.name,
      owner: input.owner,
    });
    for (const [field, value] of Object.entries(input.fields)) body.set(field, value);

    const data = await this.request<{ Story: { id: string } }>("/stories", {
      method: "POST",
      body,
    });
    return { id: String(data.Story.id) };
  }

  async getRequirement(id: string): Promise<Requirement> {
    const mapping = buildFieldMapping(await this.listCustomFields());
    const query = new URLSearchParams({
      workspace_id: this.workspaceId,
      id,
      limit: "1",
    });
    const data = await this.request<unknown[]>(`/stories?${query.toString()}`);
    if (data.length === 0) throw new Error(`TAPD requirement ${id} not found`);
    return mapTapdStory(unwrapStory(data[0]), mapping);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", this.authorization);
    if (init.body instanceof URLSearchParams) {
      headers.set("content-type", "application/x-www-form-urlencoded");
    }

    const response = await this.fetcher(`${this.endpoint}${path}`, {
      ...init,
      headers,
    });
    const payload = (await response.json()) as TapdResponse<T>;
    if (!response.ok || payload.status !== 1) {
      throw new Error(
        `TAPD request failed (${payload.status || response.status}): ${payload.info || "unknown error"}`,
      );
    }
    return payload.data;
  }
}

function parseOptions(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as string[] | Record<string, string>;
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}

function unwrapStory(entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== "object") throw new Error("Invalid TAPD story response");
  const record = entry as Record<string, unknown>;
  const story = record.Story;
  return story && typeof story === "object" ? (story as Record<string, unknown>) : record;
}
