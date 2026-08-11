import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

import { PluginUpdateError } from "./contracts.js";

export interface PluginSource {
  root: string;
  manifestPath: string;
  version: string;
}

export async function locatePluginSource(startPath: string): Promise<PluginSource> {
  let current = await resolveStartingDirectory(startPath);
  const root = parse(current).root;

  while (true) {
    const source = await readPluginSource(current);
    if (source) return source;
    if (current === root) break;
    current = dirname(current);
  }

  throw new PluginUpdateError(
    "plugin_source_not_found",
    `无法从 ${startPath} 定位 FlowRivet 插件源码`,
  );
}

async function resolveStartingDirectory(startPath: string): Promise<string> {
  try {
    const canonical = await realpath(startPath);
    return (await stat(canonical)).isDirectory() ? canonical : dirname(canonical);
  } catch (error) {
    throw new PluginUpdateError(
      "plugin_source_not_found",
      `插件启动路径不存在：${startPath}`,
      { cause: error },
    );
  }
}

async function readPluginSource(directory: string): Promise<PluginSource | undefined> {
  const manifestPath = join(directory, ".codex-plugin", "plugin.json");
  try {
    const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
      name?: unknown;
    };
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (
      packageJson.name !== "flowrivet" ||
      manifest.name !== "flowrivet" ||
      typeof manifest.version !== "string"
    ) {
      return undefined;
    }
    return { root: directory, manifestPath, version: manifest.version };
  } catch {
    return undefined;
  }
}
