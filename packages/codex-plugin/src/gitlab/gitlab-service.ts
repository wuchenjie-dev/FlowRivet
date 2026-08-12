import {
  gitLabLoginResultSchema,
  type GitLabConnection,
  type GitLabLoginResult,
  type GitLabProjectPage,
} from "../contracts/gitlab.js";
import {
  BoundedCommandRunner,
  resolveExecutable,
} from "../process/bounded-command-runner.js";
import type { GitLabAdapter } from "./gitlab-adapter.js";
import { GitLabAdapterError } from "./gitlab-adapter.js";
import { GlabCliClient } from "./glab-cli-client.js";

export const FLOWRIVET_GITLAB_HOST = "gitlab-aiabu.ruijie.com.cn";

export interface GitLabOperations {
  getConnection(): Promise<GitLabConnection>;
  startLogin(): Promise<GitLabLoginResult>;
  listProjects(input: { page: number; perPage: number }): Promise<GitLabProjectPage>;
}

export class GitLabService implements GitLabOperations {
  private readonly adapter: GitLabAdapter;
  private readonly startLoginProcess: () => Promise<void>;
  private loginProcess?: Promise<void>;
  private cachedConnection?: GitLabConnection;

  constructor(options: {
    adapter: GitLabAdapter;
    startLogin: () => Promise<void>;
  }) {
    this.adapter = options.adapter;
    this.startLoginProcess = options.startLogin;
  }

  async getConnection(): Promise<GitLabConnection> {
    if (this.loginProcess) {
      return this.cachedConnection ?? {
        host: FLOWRIVET_GITLAB_HOST,
        state: "checking",
      };
    }
    this.cachedConnection = await this.adapter.getConnection();
    return this.cachedConnection;
  }

  async startLogin(): Promise<GitLabLoginResult> {
    if (this.loginProcess) return gitLabLoginResultSchema.parse({ state: "waiting" });
    const connection = await this.getConnection();
    if (connection.state === "connected") {
      return gitLabLoginResultSchema.parse({ state: "connected" });
    }
    if (connection.state === "cli_missing" || connection.state === "cli_unsupported") {
      throw new GitLabAdapterError(`gitlab_${connection.state}` as "gitlab_cli_missing" | "gitlab_cli_unsupported");
    }
    if (connection.state === "unavailable") throw new GitLabAdapterError("gitlab_unavailable");

    this.cachedConnection = { ...connection, state: "checking" };
    const login = this.startLoginProcess();
    this.loginProcess = login;
    void login
      .then(async () => { this.cachedConnection = await this.adapter.getConnection(); })
      .catch(() => { this.cachedConnection = { ...connection, state: "disconnected" }; })
      .finally(() => { this.loginProcess = undefined; });
    return gitLabLoginResultSchema.parse({ state: "waiting" });
  }

  async listProjects(input: { page: number; perPage: number }) {
    const connection = await this.getConnection();
    if (connection.state !== "connected") throw new GitLabAdapterError("gitlab_not_connected");
    return this.adapter.listProjects(input);
  }
}

export function createDefaultGitLabService(): GitLabService {
  let client: GlabCliClient | undefined;
  let executablePath: string | undefined;
  const resolveClient = async () => {
    executablePath ??= await resolveExecutable({ command: "glab" });
    client ??= new GlabCliClient({
      executablePath,
      host: FLOWRIVET_GITLAB_HOST,
    });
    return client;
  };
  const adapter: GitLabAdapter = {
    async getConnection() {
      try {
        return await (await resolveClient()).getConnection();
      } catch {
        return { host: FLOWRIVET_GITLAB_HOST, state: "cli_missing" };
      }
    },
    async listProjects(input) {
      return (await resolveClient()).listProjects(input);
    },
  };
  return new GitLabService({
    adapter,
    startLogin: async () => {
      const resolved = await resolveClient();
      await new BoundedCommandRunner().run({
        executablePath: executablePath!,
        args: [
          "auth", "login",
          "--hostname", FLOWRIVET_GITLAB_HOST,
          "--web",
          "--git-protocol", "https",
        ],
        timeoutMs: 10 * 60_000,
      });
      await resolved.getConnection();
    },
  });
}
