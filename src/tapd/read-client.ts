import type { Requirement } from "../domain/requirement.js";
import type { CustomField } from "./fields.js";
import { buildFieldMapping, mapTapdStory } from "./mapper.js";

interface ReadClientOptions {
  endpoint: string;
  workspaceId: string;
  personalToken: string;
  pageSize?: number;
  fetcher?: typeof fetch;
}

interface TapdResponse<T> {
  status: number;
  data: T;
  info: string;
}

interface FieldConfig {
  name: string;
  type: string;
  options?: string | null;
  custom_field: string;
  enabled: string;
}

export interface RequirementReader {
  getRequirement(id: string): Promise<Requirement>;
}

export class TapdReadClient implements RequirementReader {
  private readonly endpoint: string;
  private readonly workspaceId: string;
  private readonly authorization: string;
  private readonly pageSize: number;
  private readonly fetcher: typeof fetch;

  constructor(options: ReadClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.workspaceId = options.workspaceId;
    this.authorization = `Bearer ${options.personalToken}`;
    this.pageSize = options.pageSize ?? 200;
    this.fetcher = options.fetcher ?? fetch;
  }

  async listRequirements(): Promise<Requirement[]> {
    const mapping = buildFieldMapping(await this.listCustomFields());
    const requirements: Requirement[] = [];

    for (let page = 1; ; page += 1) {
      const data = await this.request<unknown[]>(
        `/stories?workspace_id=${this.workspaceId}&limit=${this.pageSize}&page=${page}`,
      );
      requirements.push(
        ...data.map((entry) => mapTapdStory(unwrapStory(entry), mapping)),
      );
      if (data.length < this.pageSize) break;
    }

    return requirements;
  }

  async getRequirement(id: string): Promise<Requirement> {
    const mapping = buildFieldMapping(await this.listCustomFields());
    const data = await this.request<unknown[]>(
      `/stories?workspace_id=${this.workspaceId}&id=${encodeURIComponent(id)}&limit=1`,
    );
    if (data.length === 0) throw new Error(`TAPD requirement ${id} not found`);
    return mapTapdStory(unwrapStory(data[0]), mapping);
  }

  private async listCustomFields(): Promise<CustomField[]> {
    const data = await this.request<Array<FieldConfig | { CustomFieldConfig: FieldConfig }>>(
      `/stories/custom_fields_settings?workspace_id=${this.workspaceId}`,
    );
    return data.map((entry) => {
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

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.endpoint}${path}`, {
      headers: { authorization: this.authorization },
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

function unwrapStory(entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== "object") throw new Error("Invalid TAPD story response");
  const record = entry as Record<string, unknown>;
  const story = record.Story;
  return story && typeof story === "object"
    ? (story as Record<string, unknown>)
    : record;
}

function parseOptions(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as string[] | Record<string, string>;
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}
