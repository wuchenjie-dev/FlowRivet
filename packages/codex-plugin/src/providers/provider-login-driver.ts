import type { ProviderSessionIdentity } from "./provider-auth-service.js";

export interface ProviderLoginInitialization {
  attempt: unknown;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAt: string;
  intervalMs: number;
}

export type ProviderLoginPollResult =
  | { state: "pending" }
  | { state: "authorized" }
  | { state: "expired" }
  | { state: "denied" };

export interface ProviderLoginDriver {
  readonly allowedBrowserHosts: readonly string[];
  captureProfile(): Promise<string>;
  initialize(
    profileName: string,
    signal: AbortSignal,
  ): Promise<ProviderLoginInitialization>;
  poll(
    profileName: string,
    attempt: unknown,
    signal: AbortSignal,
  ): Promise<ProviderLoginPollResult>;
  verifyIdentity(profileName: string): Promise<ProviderSessionIdentity>;
  dispose(attempt: unknown): Promise<void> | void;
}
