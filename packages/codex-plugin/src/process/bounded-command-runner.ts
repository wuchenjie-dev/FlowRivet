import {
  spawn as nodeSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";

export type CommandRunnerErrorCode =
  | "provider_cli_missing"
  | "provider_timeout"
  | "provider_cancelled"
  | "provider_output_limit"
  | "provider_command_failed"
  | "provider_unavailable";

export class CommandRunnerError extends Error {
  readonly exitCode?: number;

  constructor(
    readonly code: CommandRunnerErrorCode,
    metadata: { exitCode?: number } = {},
  ) {
    super(code);
    this.name = "CommandRunnerError";
    this.exitCode = metadata.exitCode;
  }
}

export interface CommandRunInput {
  executablePath: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  allowExitCodes?: number[];
  stdin?: string;
  cwd?: string;
  environment?: Record<string, string>;
  windowsHide?: boolean;
}

export interface CommandRunResult {
  stdout: string;
  exitCode: number;
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface ExecutableResolutionInput {
  command: string;
  explicitPath?: string;
  platform?: NodeJS.Platform;
  pathValue?: string;
  fileExists?: (candidate: string) => Promise<boolean>;
}

export async function resolveExecutable(
  input: ExecutableResolutionInput,
): Promise<string> {
  const platform = input.platform ?? process.platform;
  const fileExists = input.fileExists ?? defaultFileExists;
  if (input.explicitPath) {
    if (!isAbsolute(input.explicitPath) || !await fileExists(input.explicitPath)) {
      throw new CommandRunnerError("provider_cli_missing");
    }
    return input.explicitPath;
  }

  const pathValue = input.pathValue ?? process.env.PATH ?? "";
  const pathApi = platform === "win32" ? win32 : posix;
  const extensions = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${input.command}${extension}`);
      if (await fileExists(candidate)) return candidate;
    }
  }
  throw new CommandRunnerError("provider_cli_missing");
}

export function createSpawnInvocation(
  executablePath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: false } {
  validateTokens([executablePath, ...args]);
  if (platform !== "win32" || !executablePath.toLowerCase().endsWith(".cmd")) {
    return { command: executablePath, args: [...args], shell: false };
  }
  const commandLine = [executablePath, ...args]
    .map(quoteCmdToken)
    .join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    shell: false,
  };
}

export class BoundedCommandRunner {
  private readonly spawn: SpawnProcess;
  private readonly platform: NodeJS.Platform;
  private readonly maxOutputBytes: number;
  private readonly killProcessTree: (child: ChildProcess) => Promise<void>;

  constructor(options: {
    spawn?: SpawnProcess;
    platform?: NodeJS.Platform;
    maxOutputBytes?: number;
    killProcessTree?: (child: ChildProcess) => Promise<void>;
  } = {}) {
    this.spawn = options.spawn ?? (nodeSpawn as SpawnProcess);
    this.platform = options.platform ?? process.platform;
    this.maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
    this.killProcessTree = options.killProcessTree
      ?? ((child) => defaultKillProcessTree(child, this.platform));
  }

  run(input: CommandRunInput): Promise<CommandRunResult> {
    return new Promise((resolve, reject) => {
      let invocation: ReturnType<typeof createSpawnInvocation>;
      try {
        invocation = createSpawnInvocation(input.executablePath, input.args, this.platform);
      } catch {
        reject(new CommandRunnerError("provider_unavailable"));
        return;
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawn(invocation.command, invocation.args, {
          shell: invocation.shell,
          windowsHide: input.windowsHide ?? true,
          stdio: "pipe",
          detached: this.platform !== "win32",
          windowsVerbatimArguments: this.platform === "win32"
            && input.executablePath.toLowerCase().endsWith(".cmd"),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.environment ? { env: input.environment } : {}),
        });
      } catch (error) {
        reject(spawnError(error));
        return;
      }

      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout: Buffer[] = [];
      const terminate = () => void this.killProcessTree(child).catch(() => undefined);
      const finishReject = (error: CommandRunnerError, shouldTerminate = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (shouldTerminate) terminate();
        reject(error);
      };
      const finishResolve = (result: CommandRunResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => finishReject(
        new CommandRunnerError("provider_cancelled"),
        true,
      );
      const timer = setTimeout(() => finishReject(
        new CommandRunnerError("provider_timeout"),
        true,
      ), input.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      };

      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) {
        onAbort();
        return;
      }

      child.stdout.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes > this.maxOutputBytes) {
          finishReject(new CommandRunnerError("provider_output_limit"), true);
          return;
        }
        stdout.push(buffer);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > this.maxOutputBytes) {
          finishReject(new CommandRunnerError("provider_output_limit"), true);
        }
      });
      child.once("error", (error) => finishReject(spawnError(error)));
      child.once("close", (code) => {
        const exitCode = code ?? -1;
        const allowExitCodes = input.allowExitCodes ?? [0];
        if (!allowExitCodes.includes(exitCode)) {
          finishReject(new CommandRunnerError("provider_command_failed", { exitCode }));
          return;
        }
        finishResolve({ stdout: Buffer.concat(stdout).toString("utf8"), exitCode });
      });
      if (child.stdin) {
        if (input.stdin !== undefined) child.stdin.end(input.stdin);
        else child.stdin.end();
      }
    });
  }
}

async function defaultFileExists(candidate: string) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function validateTokens(values: string[]) {
  if (values.some((value) => /[\0\r\n]/u.test(value))) {
    throw new CommandRunnerError("provider_unavailable");
  }
}

function quoteCmdToken(value: string) {
  validateTokens([value]);
  const escaped = value
    .replace(/%/gu, "%%")
    .replace(/!/gu, "^^!")
    .replace(/"/gu, '\\"');
  return `"${escaped}"`;
}

function spawnError(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error
    && error.code === "ENOENT") {
    return new CommandRunnerError("provider_cli_missing");
  }
  return new CommandRunnerError("provider_unavailable");
}

async function defaultKillProcessTree(child: ChildProcess, platform: NodeJS.Platform) {
  if (!child.pid) return;
  if (platform === "win32") {
    const killer = nodeSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
