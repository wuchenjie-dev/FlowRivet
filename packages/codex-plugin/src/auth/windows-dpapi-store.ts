import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CredentialStoreError,
  type CredentialStore,
} from "./credential-store.js";

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$protected = [Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ciphertext = [Console]::In.ReadToEnd()
$protected = [Convert]::FromBase64String($ciphertext)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $protected,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

export type PowerShellExecutor = (
  command: string,
  args: string[],
  stdin: string,
) => Promise<string>;

export interface DpapiProtector {
  protect(secret: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

export class PowerShellDpapiProtector implements DpapiProtector {
  private readonly execute: PowerShellExecutor;

  constructor(options: { execute?: PowerShellExecutor } = {}) {
    this.execute = options.execute ?? executePowerShell;
  }

  async protect(secret: string): Promise<string> {
    return this.run(PROTECT_SCRIPT, secret);
  }

  async unprotect(ciphertext: string): Promise<string> {
    return this.run(UNPROTECT_SCRIPT, ciphertext);
  }

  private async run(script: string, stdin: string) {
    try {
      const output = await this.execute(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        stdin,
      );
      return output.trim();
    } catch {
      throw new CredentialStoreError("credential_store_failed");
    }
  }
}

export class WindowsDpapiCredentialStore implements CredentialStore {
  private readonly path: string;
  private readonly protector: DpapiProtector;

  constructor(options: { directory: string; protector?: DpapiProtector }) {
    this.path = join(options.directory, "tapd-token.json");
    this.protector = options.protector ?? new PowerShellDpapiProtector();
  }

  async readTapdToken(): Promise<string | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw new CredentialStoreError("credential_store_failed");
    }

    try {
      const value = JSON.parse(contents) as { version?: unknown; ciphertext?: unknown };
      if (value.version !== 1 || typeof value.ciphertext !== "string") {
        throw new Error("invalid credential format");
      }
      return await this.protector.unprotect(value.ciphertext);
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError("credential_store_failed");
    }
  }

  async writeTapdToken(token: string): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      const ciphertext = await this.protector.protect(token);
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ version: 1, ciphertext })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError("credential_store_failed");
    }
  }

  async deleteTapdToken(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw new CredentialStoreError("credential_store_failed");
      }
    }
  }
}

function executePowerShell(
  command: string,
  args: string[],
  stdin: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(output).toString("utf8"));
      else reject(new Error("PowerShell DPAPI command failed"));
    });
    child.stdin.end(stdin, "utf8");
  });
}

function isNodeError(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
