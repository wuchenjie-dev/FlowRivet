import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";

import { locateCodexExecutable } from "./codex-locator.js";
import {
  CompanionProcessManager,
  createSystemProcessAdapter,
  type CompanionInstance,
} from "./companion-process-manager.js";
import {
  resolveCompanionPaths,
  type CompanionPaths,
} from "./companion-paths.js";
import {
  PluginUpdateError,
  type PluginUpdateErrorCode,
  type PluginUpdateOptions,
  type PluginUpdateResult,
  type PluginUpdateService,
} from "./contracts.js";
import { runCommand } from "./command-runner.js";
import { updateGitSource } from "./git-updater.js";
import { recoverManifestTransaction } from "./manifest-transaction.js";
import { selectInstalledLocalPlugin } from "./marketplace-locator.js";
import { installLocalPlugin } from "./plugin-installer.js";
import { locatePluginSource } from "./source-locator.js";

export interface PluginUpdateContext {
  sourceRoot: string;
  manifestPath: string;
  codexHome: string;
  codexExecutable: string;
  pluginId: string;
  marketplace: string;
  transactionDirectory: string;
  companionPaths?: CompanionPaths;
  host?: string;
  port?: number;
}

export interface PluginUpdateOrchestratorDependencies {
  preflight(environment: Record<string, string | undefined>): Promise<PluginUpdateContext>;
  recover(context: PluginUpdateContext): Promise<void>;
  updateSource(
    context: PluginUpdateContext,
    options: PluginUpdateOptions,
    environment: Record<string, string | undefined>,
  ): Promise<PluginUpdateResult | undefined>;
  build(
    context: PluginUpdateContext,
    environment: Record<string, string | undefined>,
  ): Promise<void>;
  install(
    context: PluginUpdateContext,
    environment: Record<string, string | undefined>,
  ): Promise<{ version: string }>;
  stop(
    context: PluginUpdateContext,
    options: PluginUpdateOptions,
    environment: Record<string, string | undefined>,
  ): Promise<void>;
  start(
    context: PluginUpdateContext,
    environment: Record<string, string | undefined>,
  ): Promise<PluginUpdateResult["companion"]>;
}

export function createPluginUpdateService(
  dependencies: PluginUpdateOrchestratorDependencies,
): PluginUpdateService {
  return async (options, environment) => {
    const context = await dependencies.preflight(environment);
    await dependencies.recover(context);
    const reexecuted = await dependencies.updateSource(context, options, environment);
    if (reexecuted) return reexecuted;
    await dependencies.build(context, environment);
    const installed = await dependencies.install(context, environment);
    await dependencies.stop(context, options, environment);
    const companion = await dependencies.start(context, environment);
    return {
      ok: true,
      plugin: "flowrivet",
      marketplace: context.marketplace,
      version: installed.version,
      companion,
      codexRestartRequired: true,
    };
  };
}

export function createDefaultPluginUpdateService(options: {
  entryPath?: string;
} = {}): PluginUpdateService {
  const entryPath = options.entryPath ?? process.argv[1] ?? process.cwd();
  return createPluginUpdateService({
    async preflight(environment) {
      const source = await locatePluginSource(entryPath);
      const codexHome = environment.CODEX_HOME ?? join(homedir(), ".codex");
      const codexExecutable = await locateCodexExecutable({ codexHome });
      const listed = await runCommand(codexExecutable, ["plugin", "list", "--json"], {
        cwd: source.root,
        env: environment as NodeJS.ProcessEnv,
        timeoutMs: 30_000,
      });
      if (listed.exitCode !== 0) {
        throw new PluginUpdateError(
          "plugin_marketplace_mismatch",
          `无法读取 Codex 插件列表：${listed.stderr.trim() || "unknown error"}`,
        );
      }
      const plugin = await selectInstalledLocalPlugin({
        codexPluginList: listed.stdout,
        sourceRoot: source.root,
      });
      const companionPaths = resolveCompanionPaths({
        sourceRoot: source.root,
        environment,
      });
      const port = Number(environment.FLOWRIVET_MCP_PORT ?? "43120");
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new PluginUpdateError(
          "companion_start_failed",
          "FLOWRIVET_MCP_PORT 必须是 1 到 65535 之间的整数",
        );
      }
      return {
        sourceRoot: source.root,
        manifestPath: source.manifestPath,
        codexHome,
        codexExecutable,
        pluginId: plugin.pluginId,
        marketplace: plugin.marketplace,
        transactionDirectory: dirname(companionPaths.instancePath),
        companionPaths,
        host: environment.FLOWRIVET_MCP_HOST ?? "127.0.0.1",
        port,
      };
    },
    async recover(context) {
      await recoverManifestTransaction({
        sourceRoot: context.sourceRoot,
        manifestPath: context.manifestPath,
        transactionDirectory: context.transactionDirectory,
      });
    },
    async updateSource(context, updateOptions, environment) {
      return updateGitSource({
        pull: updateOptions.pull,
        sourceRoot: context.sourceRoot,
        environment,
        forwardedArgs: [
          "plugin",
          "update",
          "--pull",
          "--json",
          ...(updateOptions.adoptLegacyCompanion
            ? ["--adopt-legacy-companion"]
            : []),
        ],
        buildUpdater: async () => {
          await runBuild(context.sourceRoot, environment, ["run", "build:legacy"]);
        },
        reexecute: async (reexecutedEnvironment, args) => {
          const result = await runCommand(process.execPath, [
            join(context.sourceRoot, "dist", "src", "cli.js"),
            ...args,
          ], {
            cwd: context.sourceRoot,
            env: reexecutedEnvironment as NodeJS.ProcessEnv,
            timeoutMs: 10 * 60_000,
          });
          return parseReexecutedResult(result);
        },
      });
    },
    async build(context, environment) {
      await runBuild(context.sourceRoot, environment, ["run", "build"]);
    },
    async install(context) {
      return installLocalPlugin({
        sourceRoot: context.sourceRoot,
        manifestPath: context.manifestPath,
        codexHome: context.codexHome,
        codexExecutable: context.codexExecutable,
        pluginId: context.pluginId,
        transactionDirectory: context.transactionDirectory,
      });
    },
    async stop(context, updateOptions, environment) {
      await createManager(context, environment).stopCurrent({
        json: updateOptions.json,
        adoptLegacyCompanion: updateOptions.adoptLegacyCompanion,
      });
    },
    async start(context, environment) {
      const instance = await createManager(context, environment).start();
      return toCompanionResult(instance);
    },
  });
}

function createManager(
  context: PluginUpdateContext,
  environment: Record<string, string | undefined>,
): CompanionProcessManager {
  if (!context.companionPaths || !context.host || !context.port) {
    throw new PluginUpdateError("companion_start_failed", "Companion preflight 信息不完整");
  }
  return new CompanionProcessManager({
    paths: context.companionPaths,
    host: context.host,
    port: context.port,
    adapter: createSystemProcessAdapter(),
    environment,
  });
}

async function runBuild(
  sourceRoot: string,
  environment: Record<string, string | undefined>,
  args: string[],
): Promise<void> {
  const npm = await resolveNpmInvocation({
    environment,
    platform: process.platform,
    nodeExecutable: process.execPath,
  });
  const result = await runCommand(npm.command, [...npm.prefixArgs, ...args], {
    cwd: sourceRoot,
    env: environment as NodeJS.ProcessEnv,
    timeoutMs: 10 * 60_000,
  });
  if (result.exitCode !== 0) {
    throw new PluginUpdateError(
      "build_failed",
      `FlowRivet 构建失败：${result.stderr.trim() || "unknown error"}`,
    );
  }
}

export async function resolveNpmInvocation(options: {
  platform: NodeJS.Platform;
  environment: Record<string, string | undefined>;
  nodeExecutable: string;
}): Promise<{ command: string; prefixArgs: string[] }> {
  const candidates = [
    options.environment.npm_execpath,
    join(dirname(options.nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { command: options.nodeExecutable, prefixArgs: [candidate] };
    } catch {
      // Continue to a platform executable only when npm's JS entry is unavailable.
    }
  }
  if (options.platform !== "win32") {
    return { command: "npm", prefixArgs: [] };
  }
  throw new PluginUpdateError(
    "build_failed",
    "未找到 npm CLI 的 JavaScript 入口；无法在 Windows 安全执行构建",
  );
}

function parseReexecutedResult(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): PluginUpdateResult {
  const output = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/u).at(-1) ?? "";
  try {
    const parsed = JSON.parse(output) as Partial<PluginUpdateResult> & {
      code?: string;
      error?: string;
    };
    if (result.exitCode === 0 && parsed.ok === true) return parsed as PluginUpdateResult;
    throw new PluginUpdateError(
      (parsed.code ?? "git_pull_failed") as PluginUpdateErrorCode,
      parsed.error ?? "新版 FlowRivet 更新器执行失败",
    );
  } catch (error) {
    if (error instanceof PluginUpdateError) throw error;
    throw new PluginUpdateError(
      "git_pull_failed",
      "无法解析新版 FlowRivet 更新器的结果",
      { cause: error },
    );
  }
}

function toCompanionResult(instance: CompanionInstance): PluginUpdateResult["companion"] {
  return {
    pid: instance.pid,
    instanceId: instance.instanceId,
    healthUrl: `http://${instance.host}:${instance.port}/health`,
  };
}
