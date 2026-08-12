import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, posix } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { createSystemdUserUnit } from "./linux-systemd-user.js";
import { createLaunchAgentPlist } from "./macos-launch-agent.js";

export interface StartupCommand {
  command: string;
  args: string[];
}

export interface StartupCommands {
  install: StartupCommand;
  status: StartupCommand;
  remove: StartupCommand;
}

export interface StartupManagerOptions {
  platform?: NodeJS.Platform;
  executablePath: string;
  homeDirectory?: string;
  run?: (command: string, args: string[]) => Promise<{ exitCode: number }>;
  writeFile?: (path: string, value: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
}

export class StartupManager {
  private readonly platform: NodeJS.Platform;
  private readonly run: NonNullable<StartupManagerOptions["run"]>;
  private readonly write: NonNullable<StartupManagerOptions["writeFile"]>;
  private readonly removeFile: NonNullable<StartupManagerOptions["removeFile"]>;
  private readonly commands: StartupCommands;

  constructor(private readonly options: StartupManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.commands = createStartupCommands({ platform: this.platform, executablePath: options.executablePath });
    const execute = promisify(execFile);
    this.run = options.run ?? (async (command, args) => {
      try {
        await execute(command, args, { timeout: 10_000, windowsHide: true });
        return { exitCode: 0 };
      } catch (error) {
        return { exitCode: typeof error === "object" && error && "code" in error && typeof error.code === "number" ? error.code : 1 };
      }
    });
    this.write = options.writeFile ?? (async (path, value) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
    });
    this.removeFile = options.removeFile ?? (async (path) => { await rm(path, { force: true }); });
  }

  async install(): Promise<void> {
    if (this.platform === "darwin") await this.write(this.definitionPath(), createLaunchAgentPlist(this.options.executablePath));
    if (this.platform === "linux") {
      await this.write(this.definitionPath(), createSystemdUserUnit(this.options.executablePath));
      await this.requireSuccess("/usr/bin/systemctl", ["--user", "daemon-reload"]);
    }
    await this.requireSuccess(this.commands.install.command, this.commands.install.args);
  }

  async status(): Promise<boolean> {
    return (await this.run(this.commands.status.command, this.commands.status.args)).exitCode === 0;
  }

  async remove(): Promise<void> {
    const result = await this.run(this.commands.remove.command, this.commands.remove.args);
    if (result.exitCode !== 0 && await this.status()) throw new Error("startup_remove_failed");
    if (this.platform === "darwin" || this.platform === "linux") await this.removeFile(this.definitionPath());
    if (this.platform === "linux") await this.requireSuccess("/usr/bin/systemctl", ["--user", "daemon-reload"]);
  }

  private definitionPath(): string {
    const home = this.options.homeDirectory ?? homedir();
    if (this.platform === "darwin") return posix.join(home, "Library", "LaunchAgents", "cn.flowrivet.updater.plist");
    if (this.platform === "linux") return posix.join(home, ".config", "systemd", "user", "flowrivet-updater.service");
    throw new Error("startup_definition_not_required");
  }

  private async requireSuccess(command: string, args: string[]): Promise<void> {
    if ((await this.run(command, args)).exitCode !== 0) throw new Error("startup_command_failed");
  }
}

export function createStartupCommands(options: {
  platform?: NodeJS.Platform;
  executablePath: string;
}): StartupCommands {
  if (!isAbsolute(options.executablePath)) throw new Error("updater_path_not_absolute");
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return {
      install: { command: "schtasks.exe", args: ["/Create", "/F", "/SC", "ONLOGON", "/TN", "FlowRivet Updater", "/TR", `"${options.executablePath}" run`, "/RL", "LIMITED"] },
      status: { command: "schtasks.exe", args: ["/Query", "/TN", "FlowRivet Updater"] },
      remove: { command: "schtasks.exe", args: ["/Delete", "/F", "/TN", "FlowRivet Updater"] },
    };
  }
  if (platform === "darwin") {
    return {
      install: { command: "/bin/launchctl", args: ["bootstrap", `gui/${process.getuid?.() ?? 0}`, "~/Library/LaunchAgents/cn.flowrivet.updater.plist"] },
      status: { command: "/bin/launchctl", args: ["print", `gui/${process.getuid?.() ?? 0}/cn.flowrivet.updater`] },
      remove: { command: "/bin/launchctl", args: ["bootout", `gui/${process.getuid?.() ?? 0}/cn.flowrivet.updater`] },
    };
  }
  if (platform === "linux") {
    return {
      install: { command: "/usr/bin/systemctl", args: ["--user", "enable", "--now", "flowrivet-updater.service"] },
      status: { command: "/usr/bin/systemctl", args: ["--user", "is-active", "flowrivet-updater.service"] },
      remove: { command: "/usr/bin/systemctl", args: ["--user", "disable", "--now", "flowrivet-updater.service"] },
    };
  }
  throw new Error("startup_platform_unsupported");
}
