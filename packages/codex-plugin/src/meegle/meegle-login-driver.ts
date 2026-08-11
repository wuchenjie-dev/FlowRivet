import type { ProviderSessionIdentity } from "../providers/provider-auth-service.js";
import type {
  ProviderLoginDriver,
  ProviderLoginInitialization,
  ProviderLoginPollResult,
} from "../providers/provider-login-driver.js";
import type {
  MeegleAuthStatus,
  MeegleUser,
} from "./meegle-cli-contracts.js";
import type {
  MeegleDeviceAttempt,
  MeegleDevicePollResult,
} from "./meegle-cli-client.js";

const host = "project.feishu.cn";

export interface MeegleLoginClient {
  getCurrentProfile(): Promise<string>;
  initializeDeviceLogin(
    profileName: string,
    host: string,
    signal: AbortSignal,
  ): Promise<MeegleDeviceAttempt>;
  pollDeviceLogin(
    profileName: string,
    attempt: MeegleDeviceAttempt,
    signal: AbortSignal,
  ): Promise<MeegleDevicePollResult>;
  getAuthStatus(profileName: string): Promise<MeegleAuthStatus>;
  getCurrentUser(profileName: string): Promise<MeegleUser>;
}

export type MeegleLoginDriverErrorCode =
  | "provider_profile_changed"
  | "provider_not_connected"
  | "provider_contract_invalid";

export class MeegleLoginDriverError extends Error {
  constructor(readonly code: MeegleLoginDriverErrorCode) {
    super(code);
    this.name = "MeegleLoginDriverError";
  }
}

export class MeegleLoginDriver implements ProviderLoginDriver {
  readonly allowedBrowserHosts = [host, "open.feishu.cn"] as const;

  constructor(private readonly client: MeegleLoginClient) {}

  captureProfile(): Promise<string> {
    return this.client.getCurrentProfile();
  }

  async initialize(
    profileName: string,
    signal: AbortSignal,
  ): Promise<ProviderLoginInitialization> {
    await this.assertProfile(profileName);
    const attempt = await this.client.initializeDeviceLogin(profileName, host, signal);
    return {
      attempt,
      verificationUri: attempt.verificationUri,
      verificationUriComplete: attempt.verificationUriComplete,
      userCode: attempt.userCode,
      expiresAt: attempt.expiresAt,
      intervalMs: attempt.intervalMs,
    };
  }

  async poll(
    profileName: string,
    attempt: unknown,
    signal: AbortSignal,
  ): Promise<ProviderLoginPollResult> {
    await this.assertProfile(profileName);
    if (!isMeegleDeviceAttempt(attempt)) {
      throw new MeegleLoginDriverError("provider_contract_invalid");
    }
    return this.client.pollDeviceLogin(profileName, attempt, signal);
  }

  async verifyIdentity(profileName: string): Promise<ProviderSessionIdentity> {
    await this.assertProfile(profileName);
    const status = await this.client.getAuthStatus(profileName);
    if (!status.authenticated) {
      throw new MeegleLoginDriverError("provider_not_connected");
    }
    const identity = await this.client.getCurrentUser(profileName);
    return {
      profileName,
      accountKey: identity.user_key,
      accountDisplayName: identity.name_cn || identity.name_en,
    };
  }

  dispose(_attempt: unknown): void {}

  private async assertProfile(profileName: string) {
    if (await this.client.getCurrentProfile() !== profileName) {
      throw new MeegleLoginDriverError("provider_profile_changed");
    }
  }
}

function isMeegleDeviceAttempt(value: unknown): value is MeegleDeviceAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<MeegleDeviceAttempt>;
  return typeof attempt.profileName === "string"
    && typeof attempt.verificationUri === "string"
    && typeof attempt.verificationUriComplete === "string"
    && typeof attempt.userCode === "string"
    && typeof attempt.clientId === "string"
    && typeof attempt.deviceCode === "string"
    && typeof attempt.expiresInSeconds === "number"
    && typeof attempt.intervalMs === "number"
    && typeof attempt.expiresAt === "string";
}
