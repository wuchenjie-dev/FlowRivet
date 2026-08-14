import {
  spawn as nodeSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

const knownNpmBins: Readonly<Record<string, { packageName: string; binName: string }>> = {
  meegle: { packageName: "@lark-project/meegle", binName: "meegle" },
};

export type CommandRunnerErrorCode =
  | "provider_cli_missing"
  | "provider_timeout"
  | "provider_cancelled"
  | "provider_output_limit"
  | "provider_command_failed"
  | "provider_unavailable";

export class CommandRunnerError extends Error {
  readonly exitCode?: number;
  readonly failureKind?: "provider_unauthorized";

  constructor(
    readonly code: CommandRunnerErrorCode,
    metadata: { exitCode?: number; failureKind?: "provider_unauthorized" } = {},
  ) {
    super(code);
    this.name = "CommandRunnerError";
    this.exitCode = metadata.exitCode;
    this.failureKind = metadata.failureKind;
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
  readTextFile?: (candidate: string) => Promise<string>;
}

export async function resolveExecutable(
  input: ExecutableResolutionInput,
): Promise<string> {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const fileExists = input.fileExists ?? defaultFileExists;
  const readTextFile = input.readTextFile ?? ((candidate) => readFile(candidate, "utf8"));
  const resolveKnownShim = (shimPath: string) => resolveKnownNpmShim({
    command: input.command,
    shimDirectory: pathApi.dirname(shimPath),
    pathApi,
    fileExists,
    readTextFile,
  });
  if (input.explicitPath) {
    if (!pathApi.isAbsolute(input.explicitPath) || !await fileExists(input.explicitPath)) {
      throw new CommandRunnerError("provider_cli_missing");
    }
    if (platform === "win32" && /\.(?:cmd|ps1)$/iu.test(input.explicitPath)) {
      const cliEntry = await resolveKnownShim(input.explicitPath);
      if (!cliEntry) throw new CommandRunnerError("provider_cli_missing");
      return cliEntry;
    }
    return input.explicitPath;
  }

  const pathValue = input.pathValue ?? process.env.PATH ?? "";
  const extensions = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${input.command}${extension}`);
      if (!await fileExists(candidate)) continue;
      if (platform === "win32" && /\.(?:cmd|ps1)$/iu.test(candidate)) {
        const cliEntry = await resolveKnownShim(candidate);
        if (cliEntry) return cliEntry;
        continue;
      }
      return candidate;
    }
  }
  throw new CommandRunnerError("provider_cli_missing");
}

async function resolveKnownNpmShim(input: {
  command: string;
  shimDirectory: string;
  pathApi: typeof win32;
  fileExists: (candidate: string) => Promise<boolean>;
  readTextFile: (candidate: string) => Promise<string>;
}): Promise<string | undefined> {
  const knownBin = knownNpmBins[input.command];
  if (!knownBin) return undefined;
  const packageDirectory = input.pathApi.join(
    input.shimDirectory, "node_modules", ...knownBin.packageName.split("/"),
  );
  try {
    const packageJson = JSON.parse(await input.readTextFile(
      input.pathApi.join(packageDirectory, "package.json"),
    )) as { bin?: string | Record<string, string> };
    const relativeBin = typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.[knownBin.binName];
    if (typeof relativeBin !== "string") return undefined;
    const cliEntry = input.pathApi.resolve(packageDirectory, relativeBin);
    const packagePrefix = `${input.pathApi.resolve(packageDirectory)}${input.pathApi.sep}`.toLowerCase();
    if (!cliEntry.toLowerCase().startsWith(packagePrefix)) return undefined;
    if (!/\.(?:c|m)?js$/iu.test(cliEntry) || !await input.fileExists(cliEntry)) return undefined;
    return cliEntry;
  } catch {
    return undefined;
  }
}

export function createSpawnInvocation(
  executablePath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: false } {
  validateTokens([executablePath, ...args]);
  if (platform === "win32" && /\.(?:cmd|ps1)$/iu.test(executablePath)) {
    throw new CommandRunnerError("provider_cli_missing");
  }
  if (/\.(?:c|m)?js$/iu.test(executablePath)) {
    return { command: process.execPath, args: [executablePath, ...args], shell: false };
  }
  return { command: executablePath, args: [...args], shell: false };
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
          windowsVerbatimArguments: false,
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
      const stderr: Buffer[] = [];
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
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.byteLength;
        if (stderrBytes > this.maxOutputBytes) {
          finishReject(new CommandRunnerError("provider_output_limit"), true);
          return;
        }
        stderr.push(buffer);
      });
      child.once("error", (error) => finishReject(spawnError(error)));
      child.once("close", (code) => {
        const exitCode = code ?? -1;
        const allowExitCodes = input.allowExitCodes ?? [0];
        if (!allowExitCodes.includes(exitCode)) {
          const failureKind = classifyFailure(
            Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8"),
          );
          finishReject(new CommandRunnerError("provider_command_failed", {
            exitCode, ...(failureKind ? { failureKind } : {}),
          }));
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
  if (values.some((value) => value.includes("\0"))) {
    throw new CommandRunnerError("provider_unavailable");
  }
}

function spawnError(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error
    && error.code === "ENOENT") {
    return new CommandRunnerError("provider_cli_missing");
  }
  return new CommandRunnerError("provider_unavailable");
}

function classifyFailure(stdout: string, stderr: string): "provider_unauthorized" | undefined {
  for (const value of [stdout, stderr]) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "object" || parsed === null) continue;
      for (const key of ["code", "status", "error"] as const) {
        if (!(key in parsed)) continue;
        const token = String((parsed as Record<string, unknown>)[key]).toLowerCase();
        if (["401", "403", "auth_required", "unauthorized"].includes(token)) {
          return "provider_unauthorized";
        }
      }
    } catch {
      // Unstructured command failures are unavailable, never assumed unauthorized.
    }
  }
  return undefined;
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
