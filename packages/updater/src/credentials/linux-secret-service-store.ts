import {
  CredentialStoreError,
  type CredentialCommandRunner,
  type CredentialStore,
} from "./credential-store.js";

export class LinuxSecretServiceStore implements CredentialStore {
  constructor(private readonly run: CredentialCommandRunner) {}

  async read(reference: string): Promise<string> {
    const result = await this.execute(["lookup", "application", "flowrivet", "reference", reference]);
    if (result.exitCode === 127) throw new CredentialStoreError("credential_store_unavailable");
    if (result.exitCode !== 0 || !result.stdout.trim()) throw new CredentialStoreError("credential_missing");
    return result.stdout.trimEnd();
  }

  async write(reference: string, secret: string): Promise<void> {
    const result = await this.execute([
      "store", "--label=FlowRivet GitLab Package Registry",
      "application", "flowrivet", "reference", reference,
    ], secret);
    if (result.exitCode === 127) throw new CredentialStoreError("credential_store_unavailable");
    if (result.exitCode !== 0) throw new CredentialStoreError("credential_write_failed");
  }

  async delete(reference: string): Promise<void> {
    const result = await this.execute(["clear", "application", "flowrivet", "reference", reference]);
    if (result.exitCode === 127) throw new CredentialStoreError("credential_store_unavailable");
    if (result.exitCode !== 0) throw new CredentialStoreError("credential_write_failed");
  }

  private execute(args: string[], stdin?: string) {
    return this.run("secret-tool", args, { ...(stdin === undefined ? {} : { stdin }), timeoutMs: 10_000 });
  }
}
