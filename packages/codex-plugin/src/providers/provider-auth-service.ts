import type { ProviderConnection } from "../contracts/providers.js";

export interface ProviderAuthService {
  getConnection(): Promise<ProviderConnection>;
  disconnect?(): Promise<ProviderConnection>;
  getSessionIdentity?(): ProviderSessionIdentity | undefined;
}

export interface ProviderSessionIdentity {
  profileName?: string;
  accountKey: string;
  tenantKey?: string;
  accountDisplayName: string;
  tenantDisplayName?: string;
}
