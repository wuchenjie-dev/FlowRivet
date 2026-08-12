import { spawn } from "node:child_process";

export type CredentialErrorCode =
  | "credential_missing"
  | "credential_store_unavailable"
  | "credential_read_failed"
  | "credential_write_failed";

export class CredentialStoreError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(code);
    this.name = "CredentialStoreError";
  }
}

export interface CredentialCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CredentialCommandOptions {
  stdin?: string;
  timeoutMs?: number;
}

export type CredentialCommandRunner = (
  command: string,
  args: string[],
  options: CredentialCommandOptions,
) => Promise<CredentialCommandResult>;

export interface CredentialStore {
  read(reference: string): Promise<string>;
  write(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

export const runCredentialCommand: CredentialCommandRunner = (
  command,
  args,
  options,
) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  const maxOutput = 64 * 1024;
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 10_000);
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    if (stdout.length < maxOutput) stdout += chunk.slice(0, maxOutput - stdout.length);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < maxOutput) stderr += chunk.slice(0, maxOutput - stderr.length);
  });
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve({ exitCode: code ?? -1, stdout, stderr });
  });
  child.stdin.end(options.stdin ?? "");
});
