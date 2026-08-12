import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

import {
  isCompanionInstance,
  isMatchingCompanionHealth,
  isSameProcessStart,
  type CompanionInstanceIdentity,
} from "@flowrivet/runtime-contracts";

export interface CompanionProcessInfo {
  pid: number;
  startedAt: string;
}

export interface CompanionStartOptions {
  command: string;
  arguments: string[];
  cwd: string;
  environment: Record<string, string | undefined>;
  logPath: string;
}

export interface CompanionProcessAdapter {
  start(options: CompanionStartOptions): Promise<number>;
  stop(pid: number, force: boolean): Promise<void>;
  inspect(pid: number): Promise<CompanionProcessInfo | undefined>;
}

export interface CompanionControllerOptions {
  platform?: NodeJS.Platform;
  versionsRoot: string;
  instancePath: string;
  logPath: string;
  sharedDataRoot: string;
  host: string;
  port: number;
  adapter: CompanionProcessAdapter;
  readInstance: () => Promise<unknown>;
  fetchHealth: (url: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  healthTimeoutMs?: number;
  now?: () => number;
}

export class CompanionController {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: CompanionControllerOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  async stopCurrent(): Promise<void> {
    const instance = await this.options.readInstance();
    if (instance === undefined) return;
    if (!isCompanionInstance(instance)
      || instance.host !== this.options.host
      || instance.port !== this.options.port) throw new Error("companion_ownership_unverified");
    const process = await this.options.adapter.inspect(instance.pid);
    if (!process) return;
    const health = await this.tryHealth();
    if (!isSameProcessStart(instance.processStartedAt, process.startedAt)
      || !isMatchingCompanionHealth(health, instance)) throw new Error("companion_ownership_unverified");
    await this.options.adapter.stop(instance.pid, false);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!await this.options.adapter.inspect(instance.pid)) return;
      await this.sleep(100);
    }
    await this.options.adapter.stop(instance.pid, true);
    if (await this.options.adapter.inspect(instance.pid)) throw new Error("companion_stop_failed");
  }

  async startVersion(version: string): Promise<CompanionInstanceIdentity> {
    const path = this.options.platform === "win32" ? win32 : posix;
    const versionRoot = path.join(this.options.versionsRoot, version);
    const command = path.join(versionRoot, "runtime", this.options.platform === "win32" ? "node.exe" : "node");
    const serverEntry = path.join(versionRoot, "app", "packages", "codex-plugin", "dist", "server", "index.js");
    const pid = await this.options.adapter.start({
      command,
      arguments: [serverEntry],
      cwd: path.join(versionRoot, "app"),
      environment: {
        ...process.env,
        FLOWRIVET_MCP_HOST: this.options.host,
        FLOWRIVET_MCP_PORT: String(this.options.port),
        FLOWRIVET_COMPANION_INSTANCE_FILE: this.options.instancePath,
        FLOWRIVET_DATA_ROOT: this.options.sharedDataRoot,
        FLOWRIVET_RUNTIME_VERSION: version,
        FLOWRIVET_UI_VERSION: version,
      },
      logPath: this.options.logPath,
    });
    const deadline = this.now() + (this.options.healthTimeoutMs ?? 15_000);
    while (this.now() <= deadline) {
      const processInfo = await this.options.adapter.inspect(pid);
      if (!processInfo) throw new Error("companion_start_failed");
      const instance = await this.options.readInstance();
      if (isCompanionInstance(instance) && instance.pid === pid && instance.runtimeVersion === version) {
        const health = await this.tryHealth();
        if (isMatchingCompanionHealth(health, instance)) return instance;
      }
      await this.sleep(100);
    }
    throw new Error("companion_health_timeout");
  }

  private async tryHealth(): Promise<unknown> {
    try {
      return await this.options.fetchHealth(`http://${this.options.host}:${this.options.port}/health`);
    } catch {
      return undefined;
    }
  }
}

export function createSystemCompanionProcessAdapter(): CompanionProcessAdapter {
  const execute = promisify(execFile);
  return {
    async start(options) {
      await mkdir(dirname(options.logPath), { recursive: true, mode: 0o700 });
      const descriptor = openSync(options.logPath, "a");
      try {
        const child = spawn(options.command, options.arguments, {
          cwd: options.cwd,
          env: options.environment as NodeJS.ProcessEnv,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", descriptor, descriptor],
        });
        if (!child.pid) throw new Error("companion_start_failed");
        child.unref();
        return child.pid;
      } finally {
        closeSync(descriptor);
      }
    },
    async stop(pid, force) {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    },
    async inspect(pid) {
      try {
        if (process.platform === "win32") {
          const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($null -eq $p){exit 3};$p.CreationDate.ToUniversalTime().ToString('o')`;
          const { stdout } = await execute("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 5_000, windowsHide: true });
          const startedAt = new Date(stdout.trim()).toISOString();
          return { pid, startedAt };
        }
        const { stdout } = await execute("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5_000 });
        if (!stdout.trim()) return undefined;
        return { pid, startedAt: new Date(stdout.trim()).toISOString() };
      } catch {
        return undefined;
      }
    },
  };
}
