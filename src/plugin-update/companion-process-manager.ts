import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
} from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  runCommand as defaultRunCommand,
  type CommandResult,
  type RunCommandOptions,
} from "./command-runner.js";
import type { CompanionPaths } from "./companion-paths.js";
import { PluginUpdateError } from "./contracts.js";

const COMPANION_PRODUCT = "flowrivet-companion";

export interface ProcessInfo {
  pid: number;
  executable: string;
  arguments: string[];
  startedAt: string;
}

export interface StartCompanionProcessOptions {
  command: string;
  arguments: string[];
  cwd: string;
  environment: Record<string, string | undefined>;
  logPath: string;
}

export interface CompanionProcessAdapter {
  inspect(pid: number): Promise<ProcessInfo | undefined>;
  findListener(host: string, port: number): Promise<number | undefined>;
  stop(pid: number, force: boolean): Promise<void>;
  start(options: StartCompanionProcessOptions): Promise<number>;
}

export interface CompanionInstance {
  version: 1;
  product: typeof COMPANION_PRODUCT;
  pid: number;
  processStartedAt: string;
  host: string;
  port: number;
  instanceId: string;
  startedAt: string;
}

export interface CompanionProcessManagerOptions {
  paths: CompanionPaths;
  host: string;
  port: number;
  adapter: CompanionProcessAdapter;
  environment: Record<string, string | undefined>;
  fetchHealth?: (url: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  healthTimeoutMs?: number;
  interactive?: boolean;
  confirmLegacy?: (process: ProcessInfo) => Promise<boolean>;
  nodeExecutable?: string;
}

export class CompanionProcessManager {
  private readonly fetchHealth: (url: string) => Promise<unknown>;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: CompanionProcessManagerOptions) {
    this.fetchHealth = options.fetchHealth ?? fetchCompanionHealth;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
  }

  async stopCurrent(options: {
    json: boolean;
    adoptLegacyCompanion: boolean;
  }): Promise<void> {
    const instance = await readInstance(this.options.paths.instancePath);
    if (instance) {
      await this.stopManaged(instance);
      return;
    }

    const listenerPid = await this.options.adapter.findListener(
      this.options.host,
      this.options.port,
    );
    if (listenerPid === undefined) return;
    const processInfo = await this.options.adapter.inspect(listenerPid);
    const health = await this.tryHealth();
    if (!processInfo || !isLegacyProcess(processInfo, this.options.paths) || !isStrictLegacyHealth(health)) {
      throw ownershipError("监听 Companion 端口的进程不符合旧版 FlowRivet 特征");
    }

    const interactive = this.options.interactive ?? Boolean(process.stdin?.isTTY);
    if (!options.adoptLegacyCompanion) {
      if (options.json || !interactive) {
        throw new PluginUpdateError(
          "companion_legacy_confirmation_required",
          "首次接管旧版 Companion 需要 --adopt-legacy-companion",
        );
      }
      const confirmed = await (this.options.confirmLegacy ?? confirmLegacyProcess)(processInfo);
      if (!confirmed) {
        throw new PluginUpdateError(
          "companion_legacy_confirmation_required",
          "用户未确认接管旧版 Companion",
        );
      }
    }

    const revalidated = await this.options.adapter.inspect(listenerPid);
    if (!sameProcess(processInfo, revalidated)) {
      throw ownershipError("旧版 Companion 在停止前发生变化");
    }
    await this.stopAndWait(listenerPid);
  }

  async start(): Promise<CompanionInstance> {
    await mkdir(dirname(this.options.paths.instancePath), { recursive: true });
    await mkdir(dirname(this.options.paths.logPath), { recursive: true });
    let pid: number;
    try {
      pid = await this.options.adapter.start({
        command: this.options.nodeExecutable ?? process.execPath,
        arguments: [this.options.paths.serverEntry],
        cwd: this.options.paths.sourceRoot,
        environment: {
          ...this.options.environment,
          FLOWRIVET_MCP_HOST: this.options.host,
          FLOWRIVET_MCP_PORT: String(this.options.port),
          FLOWRIVET_COMPANION_INSTANCE_FILE: this.options.paths.instancePath,
        },
        logPath: this.options.paths.logPath,
      });
    } catch (error) {
      if (error instanceof PluginUpdateError) throw error;
      throw new PluginUpdateError(
        "companion_start_failed",
        "无法启动新版 FlowRivet Companion",
        { cause: error },
      );
    }
    const deadline = Date.now() + (this.options.healthTimeoutMs ?? 15_000);
    let observedInstance = false;

    while (Date.now() <= deadline) {
      const processInfo = await this.options.adapter.inspect(pid);
      if (!processInfo) {
        throw new PluginUpdateError(
          "companion_start_failed",
          `新版 Companion 在健康检查前退出（PID ${pid}）`,
        );
      }
      const instance = await readInstance(this.options.paths.instancePath);
      if (instance?.pid === pid) {
        observedInstance = true;
        const health = await this.tryHealth();
        if (isMatchingHealth(health, instance)) {
          const normalized = { ...instance, processStartedAt: processInfo.startedAt };
          await writeInstance(this.options.paths.instancePath, normalized);
          return normalized;
        }
      }
      await this.sleep(100);
    }
    throw new PluginUpdateError(
      "companion_health_timeout",
      observedInstance
        ? "新版 Companion 未在 15 秒内通过实例身份健康检查"
        : "新版 Companion 未在 15 秒内写入实例文件",
    );
  }

  private async stopManaged(instance: CompanionInstance): Promise<void> {
    if (
      instance.host !== this.options.host ||
      instance.port !== this.options.port ||
      !isLoopbackHost(instance.host)
    ) {
      throw ownershipError("Companion 实例文件指向了非预期地址");
    }
    const process = await this.options.adapter.inspect(instance.pid);
    if (!process) {
      await rm(this.options.paths.instancePath, { force: true });
      return;
    }
    if (!sameStartedAt(instance.processStartedAt, process.startedAt)) {
      throw ownershipError("Companion PID 已被其他进程复用");
    }
    const health = await this.tryHealth();
    if (!isMatchingHealth(health, instance)) {
      throw ownershipError("Companion health 身份与实例文件不一致");
    }
    const revalidated = await this.options.adapter.inspect(instance.pid);
    if (!sameProcess(process, revalidated)) {
      throw ownershipError("Companion 在停止前发生变化");
    }
    await this.stopAndWait(instance.pid);
    await rm(this.options.paths.instancePath, { force: true });
  }

  private async stopAndWait(pid: number): Promise<void> {
    await this.options.adapter.stop(pid, false);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!await this.options.adapter.inspect(pid)) return;
      await this.sleep(100);
    }
    await this.options.adapter.stop(pid, true);
    if (await this.options.adapter.inspect(pid)) {
      throw ownershipError(`无法停止 Companion 进程 ${pid}`);
    }
  }

  private async tryHealth(): Promise<unknown> {
    try {
      return await this.fetchHealth(
        `http://${this.options.host}:${this.options.port}/health`,
      );
    } catch {
      return undefined;
    }
  }
}

export function createSystemProcessAdapter(options: {
  platform?: NodeJS.Platform;
  runCommand?: (
    command: string,
    args: string[],
    options?: RunCommandOptions,
  ) => Promise<CommandResult>;
  killProcess?: (pid: number, signal: NodeJS.Signals | number) => void;
} = {}): CompanionProcessAdapter {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? defaultRunCommand;
  const killProcess = options.killProcess ?? process.kill;
  return {
    async inspect(pid) {
      if (platform === "win32") {
        const script = [
          `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'`,
          "if($null -eq $p){exit 3}",
          "$parts=[regex]::Matches($p.CommandLine, '\"[^\"]*\"|\\S+') | ForEach-Object {$_.Value.Trim('\"')}",
          "$result=@{pid=[int]$p.ProcessId;executable=$p.ExecutablePath;arguments=@($parts | Select-Object -Skip 1);startedAt=$p.CreationDate.ToUniversalTime().ToString('o')}",
          "$result | ConvertTo-Json -Compress",
        ].join(";");
        const result = await run("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ], { timeoutMs: 5_000 });
        if (result.exitCode !== 0) return undefined;
        return parseWindowsProcess(result.stdout);
      }
      const result = await run("ps", [
        "-p",
        String(pid),
        "-o",
        "pid=",
        "-o",
        "lstart=",
        "-o",
        "comm=",
        "-o",
        "args=",
      ], { timeoutMs: 5_000 });
      return result.exitCode === 0 ? parseUnixProcess(result.stdout) : undefined;
    },
    async findListener(_host, port) {
      if (platform === "win32") {
        const result = await run("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
        ], { timeoutMs: 5_000 });
        return parsePid(result.stdout);
      }
      let result: CommandResult | undefined;
      try {
        result = await run("lsof", [
          "-nP",
          `-iTCP:${port}`,
          "-sTCP:LISTEN",
          "-t",
        ], { timeoutMs: 5_000 });
      } catch {
        result = undefined;
      }
      if (result?.exitCode === 0) return parsePid(result.stdout);
      if (platform !== "linux") return undefined;
      let fallback: CommandResult;
      try {
        fallback = await run("ss", ["-ltnp"], { timeoutMs: 5_000 });
      } catch {
        return undefined;
      }
      if (fallback.exitCode !== 0) return undefined;
      const listenerLine = fallback.stdout
        .split(/\r?\n/u)
        .find((line) => line.includes(`:${port}`) && line.includes("LISTEN"));
      const match = listenerLine?.match(/\bpid=(\d+)\b/u);
      return match ? Number(match[1]) : undefined;
    },
    async stop(pid, force) {
      killProcess(pid, force ? "SIGKILL" : "SIGTERM");
    },
    async start(startOptions) {
      const descriptor = openSync(startOptions.logPath, "a");
      try {
        const child = spawn(startOptions.command, startOptions.arguments, {
          cwd: startOptions.cwd,
          env: startOptions.environment as NodeJS.ProcessEnv,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", descriptor, descriptor],
        });
        if (!child.pid) throw new Error("Companion process did not receive a PID");
        child.unref();
        return child.pid;
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

function parseWindowsProcess(output: string): ProcessInfo | undefined {
  try {
    const value = JSON.parse(output) as Partial<ProcessInfo> & { commandLine?: string };
    if (!Number.isInteger(value.pid) || typeof value.executable !== "string" ||
      typeof value.startedAt !== "string") return undefined;
    const arguments_ = Array.isArray(value.arguments)
      ? value.arguments.filter((arg): arg is string => typeof arg === "string")
      : splitCommandLine(value.commandLine ?? "").slice(1);
    return {
      pid: value.pid!,
      executable: value.executable,
      arguments: arguments_,
      startedAt: value.startedAt,
    };
  } catch {
    return undefined;
  }
}

function parseUnixProcess(output: string): ProcessInfo | undefined {
  const trimmed = output.trim();
  if (trimmed.includes("|")) {
    const [pidText, startedAt, executable, ...arguments_] = trimmed.split("|");
    const pid = Number(pidText);
    return Number.isInteger(pid) && startedAt && executable
      ? { pid, startedAt, executable, arguments: splitCommandLine(arguments_.join("|")) }
      : undefined;
  }
  const match = trimmed.match(/^(\d+)\s+(.{24})\s+(\S+)\s*(.*)$/u);
  if (!match) return undefined;
  const startedAt = new Date(match[2]!).toISOString();
  const command = splitCommandLine(match[4] ?? "");
  return {
    pid: Number(match[1]),
    startedAt,
    executable: match[3]!,
    arguments: command.length > 0 ? command.slice(1) : [],
  };
}

function splitCommandLine(commandLine: string): string[] {
  return [...commandLine.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .filter(Boolean);
}

function parsePid(output: string): number | undefined {
  const pid = Number(output.trim().split(/\s+/u)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function readInstance(path: string): Promise<CompanionInstance | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<CompanionInstance>;
    if (value.version !== 1 || value.product !== COMPANION_PRODUCT ||
      !Number.isInteger(value.pid) || typeof value.processStartedAt !== "string" ||
      typeof value.host !== "string" || !Number.isInteger(value.port) ||
      typeof value.instanceId !== "string" || typeof value.startedAt !== "string") {
      throw ownershipError("Companion 实例文件格式无效");
    }
    return value as CompanionInstance;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function writeInstance(path: string, instance: CompanionInstance): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(instance)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fetchCompanionHealth(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`Health returned HTTP ${response.status}`);
  return response.json();
}

function isMatchingHealth(health: unknown, instance: CompanionInstance): boolean {
  if (!health || typeof health !== "object") return false;
  const value = health as Record<string, unknown>;
  return value.status === "ok" &&
    value.product === COMPANION_PRODUCT &&
    value.pid === instance.pid &&
    value.instanceId === instance.instanceId;
}

function isStrictLegacyHealth(health: unknown): boolean {
  if (!health || typeof health !== "object") return false;
  const value = health as Record<string, unknown>;
  return Object.keys(value).length === 1 && value.status === "ok";
}

function isLegacyProcess(process: ProcessInfo, paths: CompanionPaths): boolean {
  const executable = basename(process.executable).toLowerCase();
  return (executable === "node" || executable === "node.exe") &&
    process.arguments.length === 1 &&
    process.arguments[0]?.replaceAll("\\", "/") === paths.legacyServerArgument;
}

function sameProcess(
  expected: ProcessInfo,
  actual: ProcessInfo | undefined,
): boolean {
  return actual !== undefined &&
    actual.pid === expected.pid &&
    sameExactStartedAt(actual.startedAt, expected.startedAt) &&
    actual.executable === expected.executable &&
    JSON.stringify(actual.arguments) === JSON.stringify(expected.arguments);
}

function sameExactStartedAt(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

function sameStartedAt(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) &&
    Math.abs(leftTime - rightTime) <= 2_000;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

async function confirmLegacyProcess(processInfo: ProcessInfo): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `检测到旧版 FlowRivet Companion（PID ${processInfo.pid}），是否接管并重启？[y/N] `,
    );
    return /^(y|yes)$/iu.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function ownershipError(message: string): PluginUpdateError {
  return new PluginUpdateError("companion_ownership_unverified", message);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
