import type {
  ProviderConnection,
  ProviderLoginTransaction,
} from "../contracts/providers.js";

export interface ProviderAuthService {
  getConnection(): Promise<ProviderConnection>;
  startLogin?(): Promise<ProviderLoginTransaction>;
  cancelLogin?(transactionId: string): Promise<ProviderConnection>;
  disconnect?(): Promise<ProviderConnection>;
}
