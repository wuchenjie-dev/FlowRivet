import {
  type ProviderConnection,
} from "../contracts/providers.js";
import type { ProviderAuthService } from "../providers/provider-auth-service.js";
import type {
  MeegleAuthStatus,
  MeegleUser,
} from "./meegle-cli-contracts.js";
import {
  MeegleCliError,
} from "./meegle-cli-client.js";

export interface MeegleAuthClient {
  getVersion(): Promise<string>;
  getCurrentProfile(): Promise<string>;
  getAuthStatus(profile?: string): Promise<MeegleAuthStatus>;
  getCurrentUser(profile: string): Promise<MeegleUser>;
  logout(profile: string): Promise<void>;
}

export interface MeegleSessionIdentity {
  profileName: string;
  accountKey: string;
  accountDisplayName: string;
}

const providerId = "feishu-project";
const displayName = "飞书项目";

export class MeegleAuthService implements ProviderAuthService {
  private readonly client: MeegleAuthClient;
  private sessionIdentity?: MeegleSessionIdentity;

  constructor(options: {
    client: MeegleAuthClient;
    clock?: () => Date;
  }) {
    this.client = options.client;
  }

  async getConnection(): Promise<ProviderConnection> {
    try {
      await this.client.getVersion();
    } catch (error) {
      return connection(cliState(error));
    }

    let profileName: string;
    try {
      profileName = await this.client.getCurrentProfile();
    } catch (error) {
      return connection(cliState(error));
    }
    let status: MeegleAuthStatus;
    try {
      status = await this.client.getAuthStatus(profileName);
    } catch (error) {
      return connection(connectionFailureState(error), { profileName });
    }
    if (!status.authenticated) {
      this.clearIdentity(profileName);
      return connection("disconnected", { profileName });
    }

    try {
      const identity = await this.client.getCurrentUser(profileName);
      const accountDisplayName = identity.name_cn || identity.name_en;
      this.sessionIdentity = {
        profileName,
        accountKey: identity.user_key,
        accountDisplayName,
      };
      return connection("connected", { profileName, accountDisplayName });
    } catch (error) {
      this.clearIdentity(profileName);
      return connection(
        error instanceof MeegleCliError && error.code === "provider_unauthorized"
          ? "expired"
          : connectionFailureState(error),
        { profileName },
      );
    }
  }

  async disconnect(): Promise<ProviderConnection> {
    let profileName: string;
    try {
      profileName = await this.client.getCurrentProfile();
      await this.client.logout(profileName);
    } catch {
      return connection("unavailable");
    }
    this.sessionIdentity = undefined;
    return connection("disconnected", { profileName });
  }

  getSessionIdentity(): MeegleSessionIdentity | undefined {
    return this.sessionIdentity ? { ...this.sessionIdentity } : undefined;
  }

  private clearIdentity(profileName: string) {
    if (this.sessionIdentity?.profileName === profileName) this.sessionIdentity = undefined;
  }
}

function connection(
  state: ProviderConnection["state"],
  metadata: { profileName?: string; accountDisplayName?: string } = {},
): ProviderConnection {
  return {
    providerId,
    displayName,
    state,
    ...(metadata.profileName ? { profileName: metadata.profileName } : {}),
    ...(metadata.accountDisplayName
      ? { accountDisplayName: metadata.accountDisplayName }
      : {}),
  };
}

function cliState(error: unknown): ProviderConnection["state"] {
  return error instanceof MeegleCliError && error.code === "provider_cli_missing"
    ? "cli_missing"
    : "unavailable";
}

function connectionFailureState(error: unknown): ProviderConnection["state"] {
  return error instanceof MeegleCliError && error.code === "provider_unauthorized"
    ? "expired"
    : cliState(error);
}
