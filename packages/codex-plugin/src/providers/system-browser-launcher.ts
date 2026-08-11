import {
  spawn as nodeSpawn,
  type SpawnOptions,
} from "node:child_process";

export type BrowserLaunchResult = "opened" | "manual_required";

export interface BrowserProcess {
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "spawn", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  unref(): void;
}

export type BrowserSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => BrowserProcess;

export class SystemBrowserLauncherError extends Error {
  constructor(readonly code: "provider_browser_url_invalid") {
    super(code);
    this.name = "SystemBrowserLauncherError";
  }
}

export class SystemBrowserLauncher {
  private readonly platform: NodeJS.Platform;
  private readonly spawn: BrowserSpawn;

  constructor(options: {
    platform?: NodeJS.Platform;
    spawn?: BrowserSpawn;
  } = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? (nodeSpawn as unknown as BrowserSpawn);
  }

  async open(
    value: string,
    allowedHosts: readonly string[],
  ): Promise<BrowserLaunchResult> {
    const url = validateBrowserUrl(value, allowedHosts);
    const invocation = browserInvocation(this.platform, url);
    let child: BrowserProcess;
    try {
      child = this.spawn(invocation.command, invocation.args, {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      return "manual_required";
    }
    return new Promise((resolve) => {
      const onSpawn = () => {
        child.removeListener("error", onError);
        child.unref();
        resolve("opened");
      };
      const onError = () => {
        child.removeListener("spawn", onSpawn);
        resolve("manual_required");
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }
}

export function validateBrowserUrl(
  value: string,
  allowedHosts: readonly string[],
): string {
  if (/[\0\r\n]/u.test(value)) {
    throw new SystemBrowserLauncherError("provider_browser_url_invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SystemBrowserLauncherError("provider_browser_url_invalid");
  }
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  if (url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || !allowed.has(url.hostname.toLowerCase())) {
    throw new SystemBrowserLauncherError("provider_browser_url_invalid");
  }
  return url.toString();
}

function browserInvocation(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  switch (platform) {
    case "win32":
      return {
        command: "rundll32.exe",
        args: ["url.dll,FileProtocolHandler", url],
      };
    case "darwin":
      return { command: "/usr/bin/open", args: [url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}
