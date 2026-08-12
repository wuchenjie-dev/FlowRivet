import {
  BoundedCommandRunner,
  type CommandRunInput,
  type CommandRunResult,
} from "../process/bounded-command-runner.js";

export class GitCliError extends Error {
  constructor(readonly code: string) { super(code); this.name = "GitCliError"; }
}
export interface GitCommandRunner { run(input: CommandRunInput): Promise<CommandRunResult> }

export class GitCliClient {
  private readonly executablePath: string;
  private readonly runner: GitCommandRunner;
  constructor(options: { executablePath: string; runner?: GitCommandRunner }) {
    this.executablePath = options.executablePath;
    this.runner = options.runner ?? new BoundedCommandRunner();
  }

  async inspect(path: string) {
    const root = (await this.run(path, ["rev-parse", "--show-toplevel"])).trim();
    const remoteNames = (await this.run(path, ["remote"])).split(/\r?\n/u).filter(Boolean);
    if (remoteNames.some((name) => !/^[a-zA-Z0-9._-]+$/u.test(name))) {
      throw new GitCliError("git_remote_invalid");
    }
    const candidates: Array<{ remoteName: string; projectPath: string }> = [];
    for (const remoteName of remoteNames) {
      const urls = (await this.run(path, ["remote", "get-url", "--all", remoteName]))
        .split(/\r?\n/u).filter(Boolean);
      for (const url of urls) {
        try { candidates.push({ remoteName, projectPath: GitCliClient.projectPathFromRemote(url) }); }
        catch { /* Foreign remotes are ignored; selected GitLab projects still require an exact match. */ }
      }
    }
    const status = await this.run(path, ["status", "--porcelain=v1"]);
    const branch = (await this.run(path, ["branch", "--show-current"])).trim();
    const unique = candidates.filter((candidate, index) => candidates.findIndex((entry) =>
      entry.remoteName === candidate.remoteName && entry.projectPath === candidate.projectPath) === index);
    if (unique.length === 0) throw new GitCliError("git_remote_invalid");
    return { root, remotes: unique, originProjectPath: unique[0]!.projectPath, remoteName: unique[0]!.remoteName, clean: status.length === 0, branch };
  }

  async clone(url: string, target: string) {
    GitCliClient.projectPathFromRemote(url);
    await this.runner.run({
      executablePath: this.executablePath,
      args: ["clone", "--", url, target],
      timeoutMs: 10 * 60_000,
    });
  }

  static projectPathFromRemote(value: string) {
    let url: URL;
    try { url = new URL(value); } catch { throw new GitCliError("git_remote_invalid"); }
    if (url.protocol !== "https:" || url.hostname !== "gitlab-aiabu.ruijie.com.cn"
      || url.username || url.password || url.search || url.hash) {
      throw new GitCliError("git_remote_invalid");
    }
    const projectPath = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
    if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/u.test(projectPath)
      || projectPath.split("/").some((part) => part === "." || part === "..")) {
      throw new GitCliError("git_remote_invalid");
    }
    return projectPath;
  }

  private async run(cwd: string, args: string[]) {
    const result = await this.runner.run({
      executablePath: this.executablePath, args, cwd, timeoutMs: 30_000,
    });
    return result.stdout;
  }
}
