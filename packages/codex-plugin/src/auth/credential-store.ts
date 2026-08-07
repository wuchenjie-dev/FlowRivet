import { join } from "node:path";

import { WindowsDpapiCredentialStore } from "./windows-dpapi-store.js";

export type CredentialStoreErrorCode =
  | "credential_store_failed"
  | "unsupported_platform";

export class CredentialStoreError extends Error {
  constructor(readonly code: CredentialStoreErrorCode) {
    super(code === "unsupported_platform"
      ? "Secure credential storage is not supported on this platform"
      : "Secure credential storage failed");
    this.name = "CredentialStoreError";
  }
}

export interface CredentialStore {
  readTapdToken(): Promise<string | undefined>;
  writeTapdToken(token: string): Promise<void>;
  deleteTapdToken(): Promise<void>;
}

export function createCredentialStore(options: {
  platform?: NodeJS.Platform;
  localAppData?: string;
} = {}): CredentialStore {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new CredentialStoreError("unsupported_platform");
  }
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new CredentialStoreError("credential_store_failed");
  }
  return new WindowsDpapiCredentialStore({
    directory: join(localAppData, "FlowRivet"),
  });
}
