import type {
  ProjectErrorCode,
  ProviderConnection,
} from "../contracts/projects.js";

export interface ExternalProject {
  externalId: string;
  name: string;
  prettyName?: string;
}

export interface ProjectManagementProvider {
  readonly id: string;
  readonly displayName: string;
  getConnection(): Promise<ProviderConnection>;
  discoverProjects(): Promise<ExternalProject[]>;
  resolveProject(input: string): Promise<ExternalProject>;
}

export class ProjectProviderError extends Error {
  constructor(readonly code: ProjectErrorCode) {
    super(code);
    this.name = "ProjectProviderError";
  }
}
