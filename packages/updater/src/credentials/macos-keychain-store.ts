import {
  CredentialStoreError,
  type CredentialCommandRunner,
  type CredentialStore,
} from "./credential-store.js";

const SERVICE = "FlowRivet GitLab Package Registry";

export class MacosKeychainStore implements CredentialStore {
  constructor(private readonly run: CredentialCommandRunner, private readonly helperPath: string) {}

  read(reference: string): Promise<string> {
    return this.execute("read", reference).then((result) => {
      if (result.exitCode === 3) throw new CredentialStoreError("credential_missing");
      if (result.exitCode !== 0) throw new CredentialStoreError("credential_read_failed");
      if (!result.stdout) throw new CredentialStoreError("credential_missing");
      return result.stdout;
    });
  }

  async write(reference: string, secret: string): Promise<void> {
    const result = await this.execute("write", reference, secret);
    if (result.exitCode !== 0) throw new CredentialStoreError("credential_write_failed");
  }

  async delete(reference: string): Promise<void> {
    const result = await this.execute("delete", reference);
    if (result.exitCode !== 0 && result.exitCode !== 3) throw new CredentialStoreError("credential_write_failed");
  }

  private execute(operation: string, reference: string, secret?: string) {
    return this.run(this.helperPath, [operation, SERVICE, reference], {
      ...(secret === undefined ? {} : { stdin: secret }),
      timeoutMs: 10_000,
    });
  }
}
