import type {
  GitLabConnection,
  GitLabProjectPage,
} from "../contracts/gitlab.js";

export type GitLabAdapterErrorCode =
  | "gitlab_cli_missing"
  | "gitlab_cli_unsupported"
  | "gitlab_not_connected"
  | "gitlab_unavailable"
  | "gitlab_output_invalid";

export class GitLabAdapterError extends Error {
  constructor(readonly code: GitLabAdapterErrorCode) {
    super(code);
    this.name = "GitLabAdapterError";
  }
}

export interface GitLabAdapter {
  getConnection(): Promise<GitLabConnection>;
  listProjects(input: { page: number; perPage: number }): Promise<GitLabProjectPage>;
}
