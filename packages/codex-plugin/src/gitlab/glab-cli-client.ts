import {
  gitLabConnectionSchema,
  gitLabProjectPageSchema,
  type GitLabConnection,
  type GitLabProjectPage,
} from "../contracts/gitlab.js";
import {
  BoundedCommandRunner,
  CommandRunnerError,
  type CommandRunInput,
  type CommandRunResult,
} from "../process/bounded-command-runner.js";
import { glabProjectListSchema } from "./contracts.js";
import {
  GitLabAdapterError,
  type GitLabAdapter,
} from "./gitlab-adapter.js";

export { GitLabAdapterError } from "./gitlab-adapter.js";

const MINIMUM_GLAB_VERSION = [1, 113, 0] as const;

export interface GlabCommandRunner {
  run(input: CommandRunInput): Promise<CommandRunResult>;
}

export class GlabCliClient implements GitLabAdapter {
  private readonly executablePath: string;
  private readonly runner: GlabCommandRunner;
  private readonly host: string;

  constructor(options: {
    executablePath: string;
    runner?: GlabCommandRunner;
    host: string;
  }) {
    if (!isAllowedHost(options.host)) throw new GitLabAdapterError("gitlab_unavailable");
    this.executablePath = options.executablePath;
    this.runner = options.runner ?? new BoundedCommandRunner();
    this.host = options.host;
  }

  async getConnection(): Promise<GitLabConnection> {
    let versionResult: CommandRunResult;
    try {
      versionResult = await this.run(["version"]);
    } catch (error) {
      if (error instanceof GitLabAdapterError && error.code === "gitlab_cli_missing") {
        return gitLabConnectionSchema.parse({ host: this.host, state: "cli_missing" });
      }
      return gitLabConnectionSchema.parse({ host: this.host, state: "unavailable" });
    }
    const version = versionResult.stdout.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
    if (!version) {
      return gitLabConnectionSchema.parse({ host: this.host, state: "cli_unsupported" });
    }
    if (!isSupportedVersion(version)) {
      return gitLabConnectionSchema.parse({
        host: this.host,
        state: "cli_unsupported",
        cliVersion: version,
      });
    }

    let authResult: CommandRunResult;
    try {
      authResult = await this.run([
        "api", "user", "--hostname", this.host, "--method", "GET",
      ]);
    } catch (error) {
      if (error instanceof GitLabAdapterError && error.code === "gitlab_not_connected") {
        return gitLabConnectionSchema.parse({
          host: this.host,
          state: "disconnected",
          cliVersion: version,
        });
      }
      return gitLabConnectionSchema.parse({
        host: this.host,
        state: "unavailable",
        cliVersion: version,
      });
    }
    const accountDisplayName = parseUsername(authResult.stdout);
    if (!accountDisplayName) {
      return gitLabConnectionSchema.parse({
        host: this.host,
        state: "unavailable",
        cliVersion: version,
      });
    }
    return gitLabConnectionSchema.parse({
      host: this.host,
      state: "connected",
      accountDisplayName,
      cliVersion: version,
    });
  }

  async listProjects(input: { page: number; perPage: number }): Promise<GitLabProjectPage> {
    if (!Number.isInteger(input.page) || input.page < 1
      || !Number.isInteger(input.perPage) || input.perPage < 1 || input.perPage > 100) {
      throw new GitLabAdapterError("gitlab_output_invalid");
    }
    const result = await this.run([
      "repo", "list", "--member",
      "--page", String(input.page),
      "--per-page", String(input.perPage),
      "--output", "json",
    ]);
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw new GitLabAdapterError("gitlab_output_invalid");
    }
    const parsed = glabProjectListSchema.safeParse(raw);
    if (!parsed.success) throw new GitLabAdapterError("gitlab_output_invalid");
    try {
      return gitLabProjectPageSchema.parse({
        page: input.page,
        hasMore: parsed.data.length === input.perPage,
        projects: parsed.data.map((project) => ({
          host: this.host,
          projectId: String(project.id),
          pathWithNamespace: project.path_with_namespace,
          displayName: project.name,
          defaultBranch: project.default_branch,
          httpUrl: project.http_url_to_repo,
        })),
      });
    } catch {
      throw new GitLabAdapterError("gitlab_output_invalid");
    }
  }

  private async run(args: string[]) {
    try {
      return await this.runner.run({
        executablePath: this.executablePath,
        args,
        timeoutMs: 30_000,
      });
    } catch (error) {
      throw mapRunnerError(error, args[0] === "api");
    }
  }
}

function parseUsername(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && "username" in parsed
      && typeof parsed.username === "string" && parsed.username.length > 0) {
      return parsed.username;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isAllowedHost(value: string) {
  return value === "gitlab-aiabu.ruijie.com.cn";
}

function isSupportedVersion(value: string) {
  const parts = value.split(".").map(Number);
  for (let index = 0; index < MINIMUM_GLAB_VERSION.length; index += 1) {
    const actual = parts[index] ?? 0;
    const minimum = MINIMUM_GLAB_VERSION[index];
    if (actual > minimum) return true;
    if (actual < minimum) return false;
  }
  return true;
}

function mapRunnerError(error: unknown, authCommand: boolean) {
  if (error instanceof GitLabAdapterError) return error;
  if (error instanceof CommandRunnerError) {
    if (error.code === "provider_cli_missing") {
      return new GitLabAdapterError("gitlab_cli_missing");
    }
    if (authCommand && error.code === "provider_command_failed") {
      return new GitLabAdapterError("gitlab_not_connected");
    }
  }
  return new GitLabAdapterError("gitlab_unavailable");
}
