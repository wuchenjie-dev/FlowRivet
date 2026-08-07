import { describe, expect, it, vi } from "vitest";

import type { ProjectRef, ProviderConnection } from "../src/contracts/projects.js";
import { ProjectCatalogService } from "../src/projects/project-catalog-service.js";
import type {
  ExternalProject,
  ProjectManagementProvider,
} from "../src/projects/project-management-provider.js";
import { ProjectProviderError } from "../src/projects/project-management-provider.js";
import type { ProjectSelectionStore } from "../src/projects/project-selection-store.js";

const now = "2026-08-07T06:00:00.000Z";

class MemorySelectionStore implements ProjectSelectionStore {
  projects: ProjectRef[];

  constructor(projects: ProjectRef[] = []) {
    this.projects = structuredClone(projects);
  }

  async load(providerId: string) {
    return structuredClone(this.projects.filter((project) => project.providerId === providerId));
  }

  async save(providerId: string, projects: ProjectRef[]) {
    this.projects = [
      ...this.projects.filter((project) => project.providerId !== providerId),
      ...structuredClone(projects),
    ];
  }

  async clear(providerId: string) {
    this.projects = this.projects.filter((project) => project.providerId !== providerId);
  }
}

class FakeProvider implements ProjectManagementProvider {
  readonly id = "tapd";
  readonly displayName = "TAPD";
  connection: ProviderConnection = {
    providerId: "tapd",
    displayName: "TAPD",
    state: "connected",
    accountDisplayName: "吴晨杰",
  };
  discovered: ExternalProject[] = [];
  resolved = new Map<string, ExternalProject>();
  discoveryError?: ProjectProviderError;

  async getConnection() {
    return this.connection;
  }

  async discoverProjects() {
    if (this.discoveryError) throw this.discoveryError;
    return structuredClone(this.discovered);
  }

  async resolveProject(input: string) {
    const project = this.resolved.get(input);
    if (!project) throw new ProjectProviderError("project_not_found");
    return structuredClone(project);
  }
}

function saved(externalId: string, overrides: Partial<ProjectRef> = {}): ProjectRef {
  return {
    providerId: "tapd",
    externalId,
    name: `Project ${externalId}`,
    selected: true,
    available: true,
    source: "discovered",
    lastVerifiedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function setup(projects: ProjectRef[] = []) {
  const provider = new FakeProvider();
  const store = new MemorySelectionStore(projects);
  const service = new ProjectCatalogService(provider, store, () => new Date(now));
  return { provider, service, store };
}

describe("project catalog service", () => {
  it("merges discovery with saved selection and keeps new projects unselected", async () => {
    const { provider, service, store } = setup([saved("A")]);
    provider.discovered = [
      { externalId: "B", name: "Beta" },
      { externalId: "A", name: "Alpha renamed", prettyName: "Alpha" },
    ];

    const result = await service.discover();

    expect(result.stale).toBe(false);
    expect(result.projects).toEqual([
      expect.objectContaining({ externalId: "A", name: "Alpha renamed", selected: true }),
      expect.objectContaining({ externalId: "B", selected: false }),
    ]);
    expect(store.projects).toEqual(result.projects);
  });

  it("retains selected missing projects as unavailable", async () => {
    const { provider, service } = setup([saved("C")]);
    provider.discovered = [{ externalId: "A", name: "Alpha" }];

    await expect(service.discover()).resolves.toMatchObject({
      projects: [
        { externalId: "A", available: true, selected: false },
        { externalId: "C", available: false, selected: true },
      ],
    });
  });

  it("returns a stale saved catalog and does not overwrite storage when discovery fails", async () => {
    const { provider, service, store } = setup([saved("A")]);
    provider.discoveryError = new ProjectProviderError("provider_unavailable");
    const save = vi.spyOn(store, "save");

    await expect(service.discover()).resolves.toMatchObject({
      stale: true,
      errorCode: "provider_unavailable",
      projects: [{ externalId: "A" }],
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("still returns the stale catalog when connection status also cannot be refreshed", async () => {
    const { provider, service } = setup([saved("A")]);
    provider.discoveryError = new ProjectProviderError("provider_unavailable");
    provider.getConnection = vi.fn().mockRejectedValue(
      new ProjectProviderError("provider_unavailable"),
    );

    await expect(service.discover()).resolves.toMatchObject({
      provider: { providerId: "tapd", displayName: "TAPD", state: "disconnected" },
      stale: true,
      errorCode: "provider_unavailable",
      projects: [{ externalId: "A" }],
    });
  });

  it("reads the current catalog without starting discovery", async () => {
    const { provider, service } = setup([saved("A")]);
    const discover = vi.spyOn(provider, "discoverProjects");

    await expect(service.getCatalog()).resolves.toMatchObject({
      stale: false,
      projects: [{ externalId: "A" }],
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it("saves only known available project selections", async () => {
    const { service, store } = setup([
      saved("A"),
      saved("B", { selected: false }),
      saved("C", { available: false }),
    ]);

    const result = await service.saveSelection(["B"]);

    expect(result.projects).toEqual([
      expect.objectContaining({ externalId: "A", selected: false }),
      expect.objectContaining({ externalId: "B", selected: true }),
      expect.objectContaining({ externalId: "C", selected: false }),
    ]);
    expect(store.projects).toEqual(result.projects);
    await expect(service.saveSelection(["missing"])).rejects.toMatchObject({
      code: "project_not_found",
    });
    await expect(service.saveSelection(["C"])).rejects.toMatchObject({
      code: "project_not_found",
    });
  });

  it("adds a manually resolved project as unselected", async () => {
    const { provider, service } = setup();
    provider.resolved.set("50396062", { externalId: "50396062", name: "ABF" });

    await expect(service.addProject("50396062")).resolves.toMatchObject({
      projects: [{
        externalId: "50396062",
        name: "ABF",
        selected: false,
        available: true,
        source: "manual",
        lastVerifiedAt: now,
      }],
    });
  });

  it("merges a duplicate manual project without losing its selection", async () => {
    const { provider, service } = setup([saved("A", { source: "manual" })]);
    provider.resolved.set("A", { externalId: "A", name: "Updated A" });

    await expect(service.addProject("A")).resolves.toMatchObject({
      projects: [{ externalId: "A", name: "Updated A", selected: true, source: "manual" }],
    });
  });

  it("clears only the current provider catalog", async () => {
    const other = saved("J", { providerId: "jira" });
    const { service, store } = setup([saved("A"), other]);

    await service.clear();

    expect(store.projects).toEqual([other]);
  });
});
