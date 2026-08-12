import { describe, expect, it, vi } from "vitest";

import {
  CredentialStoreError,
  type CredentialCommandRunner,
} from "../src/credentials/credential-store.js";
import { createCredentialStore } from "../src/credentials/index.js";

describe("Registry credential stores", () => {
  it("writes a Windows credential through stdin without putting the token in arguments", async () => {
    const run = successfulRunner();
    const store = createCredentialStore({ platform: "win32", run });

    await store.write("FlowRivet/GitLabPackageRegistry/42", "deploy-token-value");

    expect(run).toHaveBeenCalledOnce();
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toMatch(/powershell(?:\.exe)?$/i);
    expect(args.join(" ")).not.toContain("deploy-token-value");
    expect(options.stdin).toBe("deploy-token-value");
  });

  it("uses the packaged macOS helper and passes the token only through stdin", async () => {
    const run = successfulRunner();
    const store = createCredentialStore({
      platform: "darwin",
      run,
      macosHelperPath: "/Applications/FlowRivet/macos-keychain-helper",
    });

    await store.write("project-42", "deploy-token-value");

    expect(run).toHaveBeenCalledWith(
      "/Applications/FlowRivet/macos-keychain-helper",
      ["write", "FlowRivet GitLab Package Registry", "project-42"],
      expect.objectContaining({ stdin: "deploy-token-value" }),
    );
  });

  it("uses Secret Service on Linux and reports it as unavailable", async () => {
    const run: CredentialCommandRunner = vi.fn(async () => ({ exitCode: 127, stdout: "", stderr: "missing" }));
    const store = createCredentialStore({ platform: "linux", run });

    await expect(store.read("project-42")).rejects.toMatchObject({
      code: "credential_store_unavailable",
    });
  });

  it("reads and deletes credentials without returning command diagnostics", async () => {
    const run: CredentialCommandRunner = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "secret-from-store\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const store = createCredentialStore({ platform: "linux", run });

    await expect(store.read("project-42")).resolves.toBe("secret-from-store");
    await expect(store.delete("project-42")).resolves.toBeUndefined();
    expect(JSON.stringify(run.mock.calls)).not.toContain("secret-from-store");
  });

  it("maps missing credentials to a stable error without leaking stderr", async () => {
    const run: CredentialCommandRunner = vi.fn(async () => ({
      exitCode: 3,
      stdout: "",
      stderr: "token-value was not found",
    }));
    const store = createCredentialStore({ platform: "darwin", run, macosHelperPath: "/helper" });

    try {
      await store.read("project-42");
      throw new Error("expected read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialStoreError);
      expect(error).toMatchObject({ code: "credential_missing" });
      expect(String(error)).not.toContain("token-value");
    }
  });
});

function successfulRunner() {
  return vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
}
