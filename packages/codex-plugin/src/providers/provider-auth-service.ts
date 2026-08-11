import type { ProviderConnection } from "../contracts/providers.js";

export interface ProviderAuthService {
  getConnection(): Promise<ProviderConnection>;
  disconnect?(): Promise<ProviderConnection>;
}
