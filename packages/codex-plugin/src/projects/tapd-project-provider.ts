import type { CredentialStore } from "../auth/credential-store.js";
import {
  TapdIdentityError,
  type TapdIdentityValidator,
} from "../auth/tapd-identity-client.js";
import type { ProviderConnection } from "../contracts/projects.js";
import {
  ProjectProviderError,
  type ExternalProject,
  type ProjectManagementProvider,
} from "./project-management-provider.js";

export interface TapdProjectCredentialResolver {
  resolve(expectedIdentity?: {
    accountKey: string;
    tenantKey?: string;
  }): Promise<{ token: string; accountDisplayName: string }>;
}

export class StoredTapdProjectCredentialResolver
implements TapdProjectCredentialResolver {
  constructor(private readonly options: {
    store: CredentialStore;
    identityClient: TapdIdentityValidator;
  }) {}

  async resolve(expectedIdentity?: { accountKey: string; tenantKey?: string }) {
    let token: string | undefined;
    try {
      token = await this.options.store.readTapdToken();
      if (!token) throw new ProjectProviderError("provider_not_connected");
      const identity = await this.options.identityClient.validate(token);
      if (expectedIdentity && (
        identity.accountKey !== expectedIdentity.accountKey
        || (expectedIdentity.tenantKey !== undefined
          && identity.companyId !== expectedIdentity.tenantKey)
      )) {
        throw new ProjectProviderError("provider_unauthorized");
      }
      return { token, accountDisplayName: identity.userName };
    } catch (error) {
      if (error instanceof ProjectProviderError) throw error;
      if (error instanceof TapdIdentityError) {
        throw new ProjectProviderError(error.code === "tapd_unavailable"
          ? "provider_unavailable"
          : "provider_unauthorized");
      }
      throw new ProjectProviderError("provider_unavailable");
    }
  }
}

export class TapdProjectProvider implements ProjectManagementProvider {
  readonly id = "tapd";
  readonly displayName = "TAPD";

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

  async getConnection(): Promise<ProviderConnection> {
    const credentials = await this.credentialResolver.resolve();
    return {
      providerId: this.id,
      displayName: this.displayName,
      state: "connected",
      accountDisplayName: credentials.accountDisplayName,
    };
  }

  async discoverProjects(): Promise<ExternalProject[]> {
    const credentials = await this.credentialResolver.resolve();
    const url = new URL(`${this.endpoint}/workspaces/user_participant_projects`);
    url.searchParams.set("nick", credentials.accountDisplayName);
    const payload = await this.request(url.toString(), credentials.token, "discover");
    if (Number(payload.status) !== 1 || !Array.isArray(payload.data)) {
      throw new ProjectProviderError("project_discovery_unavailable");
    }
    return payload.data
      .map(parseProject)
      .filter((project): project is ParsedProject => Boolean(
        project
        && project.category !== "organization"
        && (!project.status || project.status === "normal"),
      ))
      .map(({ externalId, name, prettyName }) => ({
        externalId,
        name,
        ...(prettyName ? { prettyName } : {}),
      }));
  }

  async resolveProject(input: string): Promise<ExternalProject> {
    const externalId = parseProjectId(input);
    if (!externalId) throw new ProjectProviderError("project_not_found");
    const credentials = await this.credentialResolver.resolve();
    const url = new URL(`${this.endpoint}/workspaces/get_workspace_info`);
    url.searchParams.set("workspace_id", externalId);
    const payload = await this.request(url.toString(), credentials.token, "resolve");
    if (Number(payload.status) !== 1) {
      throw new ProjectProviderError("project_not_found");
    }
    const data = Array.isArray(payload.data) ? payload.data[0] : payload.data;
    const project = parseProject(data);
    if (!project) throw new ProjectProviderError("project_not_found");
    return {
      externalId: project.externalId,
      name: project.name,
      ...(project.prettyName ? { prettyName: project.prettyName } : {}),
    };
  }

  private async request(
    url: string,
    token: string,
    operation: "discover" | "resolve",
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ProjectProviderError("provider_unavailable");
    }
    if (response.status === 401) {
      throw new ProjectProviderError("provider_unauthorized");
    }
    if (response.status === 403) {
      throw new ProjectProviderError(operation === "resolve"
        ? "project_forbidden"
        : "provider_unauthorized");
    }
    if (response.status === 404 && operation === "resolve") {
      throw new ProjectProviderError("project_not_found");
    }
    if (!response.ok) throw new ProjectProviderError("provider_unavailable");
    try {
      return asRecord(await response.json());
    } catch {
      throw new ProjectProviderError("provider_unavailable");
    }
  }
}

interface ParsedProject extends ExternalProject {
  category?: string;
  status?: string;
}

function parseProject(value: unknown): ParsedProject | undefined {
  const wrapper = asRecord(value);
  const project = asRecord(wrapper.Workspace ?? value);
  const id = scalarString(project.id);
  const name = scalarString(project.name);
  if (!id || !name) return undefined;
  const prettyName = scalarString(project.pretty_name ?? project.prettyName);
  const category = scalarString(project.category);
  const status = scalarString(project.status);
  return {
    externalId: id,
    name,
    ...(prettyName ? { prettyName } : {}),
    ...(category ? { category } : {}),
    ...(status ? { status } : {}),
  };
}

function parseProjectId(input: string) {
  const normalized = input.trim();
  if (/^\d+$/.test(normalized)) return normalized;
  try {
    const path = new URL(normalized).pathname;
    return path.match(/^\/tapd_fe\/(\d+)(?:\/|$)/)?.[1]
      ?? path.match(/^\/(\d+)(?:\/|$)/)?.[1];
  } catch {
    return undefined;
  }
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
