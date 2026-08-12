import {
  CredentialStoreError,
  type CredentialCommandRunner,
  type CredentialStore,
} from "./credential-store.js";

const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$operation=$args[0]",
  "$reference=$args[1]",
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class FC{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct C{public UInt32 Flags;public UInt32 Type;public string TargetName;public string Comment;public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;public UInt32 CredentialBlobSize;public IntPtr CredentialBlob;public UInt32 Persist;public UInt32 AttributeCount;public IntPtr Attributes;public string TargetAlias;public string UserName;}[DllImport(\"advapi32.dll\",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredWrite(ref C c,UInt32 f);[DllImport(\"advapi32.dll\",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredRead(string t,UInt32 y,UInt32 f,out IntPtr p);[DllImport(\"advapi32.dll\",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredDelete(string t,UInt32 y,UInt32 f);[DllImport(\"advapi32.dll\")]public static extern void CredFree(IntPtr p);}'",
  "if($operation -eq 'write'){$secret=[Console]::In.ReadToEnd();$blob=[Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($secret);try{$c=New-Object FC+C;$c.Type=1;$c.TargetName=$reference;$c.CredentialBlobSize=[Text.Encoding]::Unicode.GetByteCount($secret);$c.CredentialBlob=$blob;$c.Persist=2;$c.UserName='flowrivet';if(-not [FC]::CredWrite([ref]$c,0)){exit 4};exit 0}finally{[Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($blob)}}",
  "if($operation -eq 'read'){$p=[IntPtr]::Zero;if(-not [FC]::CredRead($reference,1,0,[ref]$p)){if([Runtime.InteropServices.Marshal]::GetLastWin32Error()-eq 1168){exit 3};exit 4};try{$c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][FC+C]);[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob,[int]($c.CredentialBlobSize/2)));exit 0}finally{[FC]::CredFree($p)}}",
  "if($operation -eq 'delete'){if(-not [FC]::CredDelete($reference,1,0)){if([Runtime.InteropServices.Marshal]::GetLastWin32Error()-ne 1168){exit 4}};exit 0}",
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
