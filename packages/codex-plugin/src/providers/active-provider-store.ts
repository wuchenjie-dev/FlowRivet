import type { ActiveProvider } from "../contracts/providers.js";

export type ActiveProviderWarningCode = "active_provider_unavailable";

export interface ActiveProviderLoadInput {
  registeredProviderIds: readonly string[];
}

export type ActiveProviderLoadResult = ActiveProvider & {
  warningCode?: ActiveProviderWarningCode;
};

export interface ActiveProviderStore {
  load(input: ActiveProviderLoadInput): Promise<ActiveProviderLoadResult>;
  save(provider: ActiveProvider): Promise<void>;
}

export type ActiveProviderStoreErrorCode =
  | "active_provider_read_failed"
  | "active_provider_write_failed";

export class ActiveProviderStoreError extends Error {
  constructor(readonly code: ActiveProviderStoreErrorCode) {
    super(code);
    this.name = "ActiveProviderStoreError";
  }
}
