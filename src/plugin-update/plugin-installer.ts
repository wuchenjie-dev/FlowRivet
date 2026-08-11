import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand as defaultRunCommand, type CommandResult } from "./command-runner.js";
import { PluginUpdateError } from "./contracts.js";
import {
  recoverManifestTransaction,
  runManifestTransaction,
} from "./manifest-transaction.js";

export interface InstallLocalPluginOptions {
  sourceRoot: string;
  manifestPath: string;
  codexHome: string;
  codexExecutable: string;
  pluginId: string;
  transactionDirectory: string;
  cachebuster?: string;
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
}

export interface InstallLocalPluginResult {
  version: string;
}

export async function installLocalPlugin(
  options: InstallLocalPluginOptions,
): Promise<InstallLocalPluginResult> {
  const run = options.runCommand ?? ((command, args) => defaultRunCommand(command, args));
  const helperPath = join(
    options.codexHome,
    "skills",
    ".system",
    "plugin-creator",
    "scripts",
    "update_plugin_cachebuster.py",
  );
  try {
    await access(helperPath);
  } catch (error) {
    throw new PluginUpdateError(
      "plugin_cachebuster_failed",
      "未找到 Codex plugin-creator cachebuster helper",
      { cause: error },
    );
  }

  await recoverManifestTransaction({
    sourceRoot: options.sourceRoot,
    manifestPath: options.manifestPath,
    transactionDirectory: options.transactionDirectory,
  });
  const originalManifest = await readFile(options.manifestPath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "flowrivet-manifest-"));
  try {
    const temporaryManifestPath = join(temporaryRoot, ".codex-plugin", "plugin.json");
    await mkdir(join(temporaryRoot, ".codex-plugin"), { recursive: true });
    await writeFile(temporaryManifestPath, originalManifest, { mode: 0o600 });
    const python = await locatePython(options.platform ?? process.platform, run);
    const cachebuster = options.cachebuster ?? createCachebuster();
    const helperResult = await run(python, [
      helperPath,
      temporaryRoot,
      "--cachebuster",
      cachebuster,
    ]);
    if (helperResult.exitCode !== 0) {
      throw new PluginUpdateError(
        "plugin_cachebuster_failed",
        `cachebuster helper 执行失败：${helperResult.stderr.trim() || "unknown error"}`,
      );
    }

    const temporaryManifest = await readFile(temporaryManifestPath);
    const version = readManifestVersion(temporaryManifest);
    await runManifestTransaction({
      sourceRoot: options.sourceRoot,
      manifestPath: options.manifestPath,
      transactionDirectory: options.transactionDirectory,
      originalManifest,
      temporaryManifest,
    }, async () => {
      const runCodex = async (args: string[]): Promise<CommandResult> => {
        try {
          return await run(options.codexExecutable, args);
        } catch (error) {
          if (error instanceof PluginUpdateError) throw error;
          throw new PluginUpdateError(
            "plugin_install_failed",
            "无法启动 Codex 插件命令",
            { cause: error },
          );
        }
      };
      const installResult = await runCodex(["plugin", "add", options.pluginId]);
      if (installResult.exitCode !== 0) {
        throw new PluginUpdateError(
          "plugin_install_failed",
          `Codex 插件安装失败：${installResult.stderr.trim() || "unknown error"}`,
        );
      }
      const listResult = await runCodex(["plugin", "list", "--json"]);
      if (
        listResult.exitCode !== 0 ||
        !isInstalledVersion(listResult.stdout, options.pluginId, version)
      ) {
        throw new PluginUpdateError(
          "plugin_install_failed",
          "Codex 插件安装命令已结束，但插件列表未确认目标版本已启用",
        );
      }
    });
    return { version };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function isInstalledVersion(json: string, pluginId: string, version: string): boolean {
  try {
    const parsed = JSON.parse(json) as { installed?: unknown };
    if (!Array.isArray(parsed.installed)) return false;
    return parsed.installed.some((value) => {
      if (!value || typeof value !== "object") return false;
      const plugin = value as Record<string, unknown>;
      return plugin.pluginId === pluginId &&
        plugin.version === version &&
        plugin.installed === true &&
        plugin.enabled === true;
    });
  } catch {
    return false;
  }
}

async function locatePython(
  platform: NodeJS.Platform,
  run: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<string> {
  const candidates = platform === "win32" ? ["py", "python"] : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      const result = await run(candidate, ["--version"]);
      if (result.exitCode === 0) return candidate;
    } catch {
      // Continue to the next conventional Python executable.
    }
  }
  throw new PluginUpdateError(
    "plugin_cachebuster_failed",
    "未找到可运行 plugin-creator helper 的 Python 3",
  );
}

function readManifestVersion(contents: Buffer): string {
  try {
    const manifest = JSON.parse(contents.toString("utf8")) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.length > 0) {
      return manifest.version;
    }
  } catch {
    // Report one stable cachebuster error below.
  }
  throw new PluginUpdateError(
    "plugin_cachebuster_failed",
    "cachebuster helper 生成了无效的插件 manifest",
  );
}

function createCachebuster(): string {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}
