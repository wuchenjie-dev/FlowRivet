import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class CommandTimeoutError extends Error {
  readonly code = "command_timeout";

  constructor(command: string, timeoutMs: number) {
    super(`Command timed out after ${timeoutMs} ms: ${command}`);
    this.name = "CommandTimeoutError";
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new CommandTimeoutError(command, timeoutMs));
        return;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
