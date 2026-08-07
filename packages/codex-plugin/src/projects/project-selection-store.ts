import type { ProjectRef } from "../contracts/projects.js";

export interface ProjectSelectionStore {
  load(providerId: string): Promise<ProjectRef[]>;
  save(providerId: string, projects: ProjectRef[]): Promise<void>;
  clear(providerId: string): Promise<void>;
}

export class ProjectSelectionStoreError extends Error {
  readonly code = "selection_store_failed" as const;

  constructor() {
    super("Project selection storage failed");
    this.name = "ProjectSelectionStoreError";
  }
}
