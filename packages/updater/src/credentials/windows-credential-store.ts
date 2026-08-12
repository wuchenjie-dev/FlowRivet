import {
  CredentialStoreError,
  type CredentialCommandRunner,
  type CredentialStore,
} from "./credential-store.js";

const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$operation=$args[0]",
  "$reference=$args[1]",
  "$vault=New-Object Windows.Security.Credentials.PasswordVault",
  "if($operation -eq 'write'){$secret=[Console]::In.ReadToEnd();$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($reference,'flowrivet',$secret)));exit 0}",
  "if($operation -eq 'read'){try{$c=$vault.Retrieve($reference,'flowrivet');$c.RetrievePassword();[Console]::Out.Write($c.Password);exit 0}catch{exit 3}}",
  "if($operation -eq 'delete'){try{$c=$vault.Retrieve($reference,'flowrivet');$vault.Remove($c)}catch{};exit 0}",
  "exit 2",
].join(";");

export class WindowsCredentialStore implements CredentialStore {
  constructor(private readonly run: CredentialCommandRunner) {}

  async read(reference: string): Promise<string> {
    const result = await this.execute({ operation: "read", reference });
    if (result.exitCode === 3) throw new CredentialStoreError("credential_missing");
    if (result.exitCode !== 0) throw new CredentialStoreError("credential_read_failed");
    if (!result.stdout) throw new CredentialStoreError("credential_missing");
    return result.stdout;
  }

  async write(reference: string, secret: string): Promise<void> {
    const result = await this.execute({ operation: "write", reference, secret });
    if (result.exitCode !== 0) throw new CredentialStoreError("credential_write_failed");
  }

  async delete(reference: string): Promise<void> {
    const result = await this.execute({ operation: "delete", reference });
    if (result.exitCode !== 0) throw new CredentialStoreError("credential_write_failed");
  }

  private execute(request: Record<string, string>) {
    return this.run("powershell", [
      "-NoProfile", "-NonInteractive", "-Command", SCRIPT,
      request.operation!, request.reference!,
    ], {
      ...(request.secret === undefined ? {} : { stdin: request.secret }),
      timeoutMs: 10_000,
    });
  }
}
