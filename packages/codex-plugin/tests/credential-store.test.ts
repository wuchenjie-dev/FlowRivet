import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CredentialStoreError,
  createCredentialStore,
} from "../src/auth/credential-store.js";
import {
  PowerShellDpapiProtector,
  WindowsDpapiCredentialStore,
} from "../src/auth/windows-dpapi-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "flowrivet-credentials-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("PowerShell DPAPI protector", () => {
  it("passes secrets through stdin instead of process arguments", async () => {
    const execute = vi.fn().mockResolvedValue("encrypted-value\n");
    const protector = new PowerShellDpapiProtector({ execute });
    const token = "tapd-secret-token";

    await expect(protector.protect(token)).resolves.toBe("encrypted-value");
    expect(execute).toHaveBeenCalledOnce();
    const [command, args, stdin] = execute.mock.calls[0] as [string, string[], string];
    expect(command.toLowerCase()).toContain("powershell");
    expect(args.join(" ")).not.toContain(token);
    expect(stdin).toBe(token);
  });

  it("maps command failures without including the secret", async () => {
    const token = "never-print-this-token";
    const protector = new PowerShellDpapiProtector({
      execute: vi.fn().mockRejectedValue(new Error(`failed ${token}`)),
    });

    await expect(protector.protect(token)).rejects.toMatchObject({
      code: "credential_store_failed",
    });
    await expect(protector.protect(token)).rejects.not.toThrow(token);
  });
});

describe("Windows DPAPI credential store", () => {
  it("writes only ciphertext and restores the token", async () => {
    const directory = await temporaryDirectory();
    const protector = {
      protect: vi.fn().mockResolvedValue("base64-ciphertext"),
      unprotect: vi.fn().mockResolvedValue("tapd-token"),
    };
    const store = new WindowsDpapiCredentialStore({ directory, protector });

    await store.writeTapdToken("tapd-token");

    const files = await readdir(directory);
    expect(files).toEqual(["tapd-token.json"]);
    const contents = await readFile(join(directory, "tapd-token.json"), "utf8");
    expect(contents).not.toContain("tapd-token");
    expect(JSON.parse(contents)).toEqual({ version: 1, ciphertext: "base64-ciphertext" });
    await expect(store.readTapdToken()).resolves.toBe("tapd-token");
    expect(protector.unprotect).toHaveBeenCalledWith("base64-ciphertext");
  });

  it("deletes the credential and treats a missing file as disconnected", async () => {
    const directory = await temporaryDirectory();
    const store = new WindowsDpapiCredentialStore({
      directory,
      protector: {
        protect: vi.fn().mockResolvedValue("ciphertext"),
        unprotect: vi.fn().mockResolvedValue("token"),
      },
    });

    await expect(store.readTapdToken()).resolves.toBeUndefined();
    await store.writeTapdToken("token");
    await store.deleteTapdToken();
    await expect(store.readTapdToken()).resolves.toBeUndefined();
  });

  it("does not leave a credential or temporary file when protection fails", async () => {
    const directory = await temporaryDirectory();
    const store = new WindowsDpapiCredentialStore({
      directory,
      protector: {
        protect: vi.fn().mockRejectedValue(new Error("DPAPI unavailable")),
        unprotect: vi.fn(),
      },
    });

    await expect(store.writeTapdToken("tapd-token")).rejects.toMatchObject({
      code: "credential_store_failed",
    });
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});

describe("credential store factory", () => {
  it("keeps the app startable and rejects operations on unsupported platforms", async () => {
    const store = createCredentialStore({ platform: "linux" });

    await expect(store.readTapdToken()).rejects.toEqual(
      expect.objectContaining<Partial<CredentialStoreError>>({
        code: "unsupported_platform",
      }),
    );
  });
});
