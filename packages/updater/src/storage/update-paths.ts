import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface UpdatePaths {
  root: string;
  versions: string;
  downloads: string;
  config: string;
  logs: string;
  current: string;
  state: string;
}

export function resolveUpdatePaths(options: {
  platform?: NodeJS.Platform;
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
} = {}): UpdatePaths {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const path = platform === "win32" ? win32 : posix;
  let root: string;
  if (platform === "win32") {
    if (!environment.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required on Windows");
    root = win32.join(environment.LOCALAPPDATA, "FlowRivet");
  } else if (platform === "darwin") {
    root = posix.join(home, "Library", "Application Support", "FlowRivet");
  } else {
    root = environment.XDG_DATA_HOME
      ? posix.join(environment.XDG_DATA_HOME, "flowrivet")
      : posix.join(home, ".local", "share", "flowrivet");
  }
  return {
    root,
    versions: path.join(root, "versions"),
    downloads: path.join(root, "downloads"),
    config: path.join(root, "config"),
    logs: path.join(root, "logs"),
    current: path.join(root, "current.json"),
    state: path.join(root, "update-state.json"),
  };
}
