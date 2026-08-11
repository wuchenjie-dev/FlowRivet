import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface CompanionPaths {
  sourceRoot: string;
  packageRoot: string;
  serverEntry: string;
  instancePath: string;
  logPath: string;
  legacyServerArgument: string;
}

export function resolveCompanionPaths(options: {
  sourceRoot: string;
  platform?: NodeJS.Platform;
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
}): CompanionPaths {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const path = platform === "win32" ? win32 : posix;
  let configDirectory: string;
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA is required on Windows");
    configDirectory = win32.join(localAppData, "FlowRivet");
  } else if (platform === "darwin") {
    configDirectory = posix.join(
      homeDirectory,
      "Library",
      "Application Support",
      "FlowRivet",
    );
  } else {
    configDirectory = environment.XDG_CONFIG_HOME
      ? posix.join(environment.XDG_CONFIG_HOME, "flowrivet")
      : posix.join(homeDirectory, ".config", "flowrivet");
  }
  const packageRoot = path.join(options.sourceRoot, "packages", "codex-plugin");
  return {
    sourceRoot: options.sourceRoot,
    packageRoot,
    serverEntry: path.join(packageRoot, "dist", "server", "index.js"),
    instancePath: environment.FLOWRIVET_COMPANION_INSTANCE_FILE ??
      path.join(configDirectory, "companion-instance.json"),
    logPath: path.join(configDirectory, "companion.log"),
    legacyServerArgument: "dist/server/index.js",
  };
}
