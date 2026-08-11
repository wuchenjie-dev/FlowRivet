import { access } from "node:fs/promises";
import { join } from "node:path";

import { runCommand as defaultRunCommand, type CommandResult } from "./command-runner.js";
import { PluginUpdateError } from "./contracts.js";

export interface LocateCodexExecutableOptions {
  codexHome: string;
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
}

export async function locateCodexExecutable(
  options: LocateCodexExecutableOptions,
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? ((command, args) => defaultRunCommand(command, args));
  const bundled = join(
    options.codexHome,
    "plugins",
    ".plugin-appserver",
    platform === "win32" ? "codex.exe" : "codex",
  );
  const candidates: string[] = [];
  try {
    await access(bundled);
    candidates.push(bundled);
  } catch {
    // The PATH fallback below supports standalone Codex installations.
  }
  candidates.push("codex");

  for (const candidate of candidates) {
    try {
      const result = await run(candidate, ["--version"]);
      if (result.exitCode === 0) return candidate;
    } catch {
      // Try the next known installation location.
    }
  }

  throw new PluginUpdateError(
    "codex_cli_not_found",
    "未找到可用的 Codex CLI；请先安装或修复 Codex",
  );
}
