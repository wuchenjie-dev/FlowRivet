import {
  runCommand as defaultRunCommand,
  type CommandResult,
  type RunCommandOptions,
} from "./command-runner.js";
import {
  PluginUpdateError,
  type PluginUpdateResult,
} from "./contracts.js";

export const PLUGIN_UPDATE_REEXEC_ENV = "FLOWRIVET_PLUGIN_UPDATE_REEXEC";

export interface GitUpdateOptions {
  pull: boolean;
  sourceRoot: string;
  environment: Record<string, string | undefined>;
  forwardedArgs: string[];
  runCommand?: (
    command: string,
    args: string[],
    options?: RunCommandOptions,
  ) => Promise<CommandResult>;
  buildUpdater: () => Promise<void>;
  reexecute: (
    environment: Record<string, string | undefined>,
    args: string[],
  ) => Promise<PluginUpdateResult>;
}

export async function updateGitSource(
  options: GitUpdateOptions,
): Promise<PluginUpdateResult | undefined> {
  if (!options.pull || options.environment[PLUGIN_UPDATE_REEXEC_ENV] === "1") {
    return undefined;
  }
  const run = options.runCommand ?? defaultRunCommand;
  const commandOptions = { cwd: options.sourceRoot, timeoutMs: 60_000 };
  const runGit = async (args: string[]): Promise<CommandResult> => {
    try {
      return await run("git", args, commandOptions);
    } catch (error) {
      if (error instanceof PluginUpdateError) throw error;
      throw new PluginUpdateError(
        "git_pull_failed",
        "无法启动 Git 命令",
        { cause: error },
      );
    }
  };
  const status = await runGit(["status", "--porcelain"]);
  if (status.exitCode !== 0) {
    throw new PluginUpdateError(
      "git_pull_failed",
      `无法检查 Git 工作区：${status.stderr.trim() || "unknown error"}`,
    );
  }
  if (status.stdout.trim().length > 0) {
    throw new PluginUpdateError(
      "git_worktree_dirty",
      "--pull 仅允许在没有未提交修改的工作区运行",
    );
  }

  const upstream = await runGit([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream.exitCode !== 0 || upstream.stdout.trim().length === 0) {
    throw new PluginUpdateError(
      "git_upstream_missing",
      "当前分支没有可拉取的 upstream",
    );
  }

  const pull = await runGit(["pull", "--ff-only"]);
  if (pull.exitCode !== 0) {
    throw new PluginUpdateError(
      "git_pull_failed",
      `Git fast-forward 拉取失败：${pull.stderr.trim() || "unknown error"}`,
    );
  }

  try {
    await options.buildUpdater();
  } catch (error) {
    if (error instanceof PluginUpdateError) throw error;
    throw new PluginUpdateError(
      "build_failed",
      "拉取完成，但无法构建新版 FlowRivet 更新器",
      { cause: error },
    );
  }

  return options.reexecute({
    ...options.environment,
    [PLUGIN_UPDATE_REEXEC_ENV]: "1",
  }, options.forwardedArgs);
}
