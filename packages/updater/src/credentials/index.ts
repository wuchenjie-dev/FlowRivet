import { LinuxSecretServiceStore } from "./linux-secret-service-store.js";
import { MacosKeychainStore } from "./macos-keychain-store.js";
import {
  runCredentialCommand,
  type CredentialCommandRunner,
  type CredentialStore,
} from "./credential-store.js";
import { WindowsCredentialStore } from "./windows-credential-store.js";

export function createCredentialStore(options: {
  platform?: NodeJS.Platform;
  run?: CredentialCommandRunner;
  macosHelperPath?: string;
} = {}): CredentialStore {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCredentialCommand;
  if (platform === "win32") return new WindowsCredentialStore(run);
  if (platform === "darwin") {
    if (!options.macosHelperPath) throw new Error("macos_keychain_helper_missing");
    return new MacosKeychainStore(run, options.macosHelperPath);
  }
  if (platform === "linux") return new LinuxSecretServiceStore(run);
  throw new Error("credential_platform_unsupported");
}
