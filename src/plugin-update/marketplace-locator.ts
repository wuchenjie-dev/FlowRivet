import { realpath as defaultRealpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { PluginUpdateError } from "./contracts.js";

export interface InstalledLocalPlugin {
  pluginId: string;
  marketplace: string;
  version: string;
  sourcePath: string;
}

export interface SelectInstalledLocalPluginOptions {
  codexPluginList: string;
  sourceRoot: string;
  platform?: NodeJS.Platform;
  realpath?: (path: string) => Promise<string>;
}

interface CodexPluginEntry {
  pluginId?: unknown;
  name?: unknown;
  marketplaceName?: unknown;
  version?: unknown;
  installed?: unknown;
  enabled?: unknown;
  source?: { source?: unknown; path?: unknown };
  marketplaceSource?: { sourceType?: unknown; source?: unknown };
}

export async function selectInstalledLocalPlugin(
  options: SelectInstalledLocalPluginOptions,
): Promise<InstalledLocalPlugin> {
  const platform = options.platform ?? process.platform;
  const resolveRealpath = options.realpath ?? defaultRealpath;
  const installed = parseInstalled(options.codexPluginList);
  const canonicalSource = canonicalPath(await resolveRealpath(options.sourceRoot), platform);
  const matches: InstalledLocalPlugin[] = [];

  for (const entry of installed) {
    if (!isEligibleFlowRivetEntry(entry)) continue;
    try {
      const sourcePath = entry.source?.path as string;
      const resolvedSource = canonicalPath(await resolveRealpath(sourcePath), platform);
      if (resolvedSource !== canonicalSource) continue;
      matches.push({
        pluginId: entry.pluginId as string,
        marketplace: entry.marketplaceName as string,
        version: entry.version as string,
        sourcePath,
      });
    } catch {
      // Broken local source entries cannot identify this checkout.
    }
  }

  if (matches.length === 0) {
    throw new PluginUpdateError(
      "plugin_marketplace_mismatch",
      "未找到唯一指向当前源码的已启用本地 FlowRivet 插件",
    );
  }
  if (matches.length > 1) {
    throw new PluginUpdateError(
      "plugin_marketplace_ambiguous",
      "多个已启用本地 FlowRivet 插件同时指向当前源码",
    );
  }
  return matches[0]!;
}

function parseInstalled(json: string): CodexPluginEntry[] {
  try {
    const parsed = JSON.parse(json) as { installed?: unknown };
    return Array.isArray(parsed.installed) ? parsed.installed as CodexPluginEntry[] : [];
  } catch {
    return [];
  }
}

function isEligibleFlowRivetEntry(entry: CodexPluginEntry): boolean {
  return entry.name === "flowrivet" &&
    entry.installed === true &&
    entry.enabled === true &&
    entry.source?.source === "local" &&
    typeof entry.source.path === "string" &&
    entry.marketplaceSource?.sourceType === "local" &&
    typeof entry.pluginId === "string" &&
    typeof entry.marketplaceName === "string" &&
    typeof entry.version === "string";
}

function canonicalPath(path: string, platform: NodeJS.Platform): string {
  const implementation = platform === "win32" ? win32 : posix;
  const withoutExtendedPrefix = path.replace(/^\\\\\?\\/, "");
  const normalized = implementation.normalize(withoutExtendedPrefix);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
