import type {
  ProjectCatalogResult,
  ProjectErrorCode,
  ProjectRef,
  ProviderConnection,
} from "../contracts/projects.js";
import type {
  ExternalProject,
  ProjectManagementProvider,
} from "./project-management-provider.js";
import { ProjectProviderError } from "./project-management-provider.js";
import type { ProjectSelectionStore } from "./project-selection-store.js";

export interface ProjectCatalog {
  getCatalog(): Promise<ProjectCatalogResult>;
  discover(): Promise<ProjectCatalogResult>;
  saveSelection(externalIds: string[]): Promise<ProjectCatalogResult>;
  addProject(input: string): Promise<ProjectCatalogResult>;
  clear(): Promise<void>;
}

export class ProjectCatalogService implements ProjectCatalog {
  constructor(
    private readonly provider: ProjectManagementProvider,
    private readonly store: ProjectSelectionStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async getCatalog(): Promise<ProjectCatalogResult> {
    return this.result(
      enableAvailable(await this.store.load(this.provider.id)),
      false,
    );
  }

  async discover(): Promise<ProjectCatalogResult> {
    const saved = enableAvailable(await this.store.load(this.provider.id));
    let discovered: ExternalProject[];

    try {
      discovered = await this.provider.discoverProjects();
    } catch (error) {
      return this.result(saved, true, providerErrorCode(error));
    }

    const savedById = new Map(saved.map((project) => [project.externalId, project]));
    const verifiedAt = this.clock().toISOString();
    const projects: ProjectRef[] = discovered.map((project) => {
      const previous = savedById.get(project.externalId);
      savedById.delete(project.externalId);
      return {
        providerId: this.provider.id,
        externalId: project.externalId,
        name: project.name,
        ...(project.prettyName ? { prettyName: project.prettyName } : {}),
        selected: true,
        available: true,
        source: previous?.source ?? "discovered",
        lastVerifiedAt: verifiedAt,
      };
    });

    for (const missing of savedById.values()) {
      if (missing.selected) projects.push({ ...missing, available: false });
    }

    const sorted = sortProjects(projects);
    await this.store.save(this.provider.id, sorted);
    return this.result(sorted, false);
  }

  async saveSelection(externalIds: string[]): Promise<ProjectCatalogResult> {
    const projects = await this.store.load(this.provider.id);
    const requested = new Set(externalIds);
    const availableIds = new Set(
      projects.filter((project) => project.available).map((project) => project.externalId),
    );
    if ([...requested].some((externalId) => !availableIds.has(externalId))) {
      throw new ProjectProviderError("project_not_found");
    }

    const updated = sortProjects(projects.map((project) => ({
      ...project,
      selected: requested.has(project.externalId),
    })));
    await this.store.save(this.provider.id, updated);
    return this.result(updated, false);
  }

  async addProject(input: string): Promise<ProjectCatalogResult> {
    const resolved = await this.provider.resolveProject(input);
    const projects = await this.store.load(this.provider.id);
    const previous = projects.find((project) => project.externalId === resolved.externalId);
    const updatedProject: ProjectRef = {
      providerId: this.provider.id,
      externalId: resolved.externalId,
      name: resolved.name,
      ...(resolved.prettyName ? { prettyName: resolved.prettyName } : {}),
      selected: previous?.selected ?? false,
      available: true,
      source: "manual",
      lastVerifiedAt: this.clock().toISOString(),
    };
    const updated = sortProjects([
      ...projects.filter((project) => project.externalId !== resolved.externalId),
      updatedProject,
    ]);
    await this.store.save(this.provider.id, updated);
    return this.result(updated, false);
  }

  async clear(): Promise<void> {
    await this.store.clear(this.provider.id);
  }

  private async result(
    projects: ProjectRef[],
    stale: boolean,
    errorCode?: ProjectErrorCode,
  ): Promise<ProjectCatalogResult> {
    return {
      provider: await this.getConnection(stale),
      projects: sortProjects(projects),
      stale,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  private async getConnection(allowFallback: boolean): Promise<ProviderConnection> {
    try {
      return await this.provider.getConnection();
    } catch (error) {
      if (!allowFallback) throw error;
      return {
        providerId: this.provider.id,
        displayName: this.provider.displayName,
        state: error instanceof ProjectProviderError
          && error.code === "provider_unauthorized"
          ? "expired"
          : "disconnected",
      };
    }
  }
}

function providerErrorCode(error: unknown): ProjectErrorCode {
  return error instanceof ProjectProviderError
    ? error.code
    : "project_discovery_unavailable";
}

function sortProjects(projects: ProjectRef[]): ProjectRef[] {
  return [...projects].sort((left, right) => {
    if (left.available !== right.available) return left.available ? -1 : 1;
    return left.name.localeCompare(right.name) || left.externalId.localeCompare(right.externalId);
  });
}

function enableAvailable(projects: ProjectRef[]): ProjectRef[] {
  return projects.map((project) => project.available
    ? { ...project, selected: true }
    : project);
}
