import { randomUUID } from "node:crypto";

import {
  providerLoginTransactionSchema,
  type ProviderConnection,
  type ProviderLoginTransaction,
} from "../contracts/providers.js";
import type { ProviderAuthService } from "../providers/provider-auth-service.js";
import type {
  MeegleAuthStatus,
  MeegleUser,
} from "./meegle-cli-contracts.js";
import {
  MeegleCliError,
  type MeegleDeviceLoginEvent,
} from "./meegle-cli-client.js";

export interface MeegleAuthClient {
  getVersion(): Promise<string>;
  getCurrentProfile(): Promise<string>;
  getAuthStatus(profile?: string): Promise<MeegleAuthStatus>;
  getCurrentUser(profile: string): Promise<MeegleUser>;
  startDeviceLogin(
    host: string,
    signal: AbortSignal,
    onEvent: (event: MeegleDeviceLoginEvent) => void,
  ): Promise<void>;
  logout(profile: string): Promise<void>;
}

export type MeegleAuthErrorCode =
  | "provider_login_transaction_not_found"
  | "provider_authorization_in_progress"
  | "provider_login_failed";

export class MeegleAuthError extends Error {
  constructor(readonly code: MeegleAuthErrorCode) {
    super(code);
    this.name = "MeegleAuthError";
  }
}

export interface MeegleSessionIdentity {
  profileName: string;
  accountKey: string;
  accountDisplayName: string;
}

interface LoginRecord {
  transactionId: string;
  profileName: string;
  controller: AbortController;
  ready: Promise<ProviderLoginTransaction>;
  transaction?: ProviderLoginTransaction;
  timer: ReturnType<typeof setTimeout>;
}

const providerId = "feishu-project";
const displayName = "飞书项目";
const authorizationLimitMs = 5 * 60 * 1_000;

export class MeegleAuthService implements ProviderAuthService {
  private readonly client: MeegleAuthClient;
  private readonly clock: () => Date;
  private readonly transactionId: () => string;
  private readonly loginByProfile = new Map<string, LoginRecord>();
  private sessionIdentity?: MeegleSessionIdentity;

  constructor(options: {
    client: MeegleAuthClient;
    clock?: () => Date;
    transactionId?: () => string;
  }) {
    this.client = options.client;
    this.clock = options.clock ?? (() => new Date());
    this.transactionId = options.transactionId ?? randomUUID;
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
    if (this.loginByProfile.has(profileName)) {
      return connection("authorizing", { profileName });
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

  async startLogin(): Promise<ProviderLoginTransaction> {
    let profileName: string;
    try {
      await this.client.getVersion();
      profileName = await this.client.getCurrentProfile();
    } catch {
      throw new MeegleAuthError("provider_login_failed");
    }
    const current = this.loginByProfile.get(profileName);
    if (current) return current.ready;

    const controller = new AbortController();
    const transactionId = this.transactionId();
    let resolveReady!: (value: ProviderLoginTransaction) => void;
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<ProviderLoginTransaction>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const record: LoginRecord = {
      transactionId,
      profileName,
      controller,
      ready,
      timer: setTimeout(() => {
        this.removeLogin(record);
        controller.abort();
        if (!record.transaction) rejectReady(new MeegleAuthError("provider_login_failed"));
      }, authorizationLimitMs),
    };
    this.loginByProfile.set(profileName, record);

    void this.client.startDeviceLogin(
      "project.feishu.cn",
      controller.signal,
      (event) => {
        if (event.type === "verification" && !record.transaction) {
          const maximumExpiry = this.clock().getTime() + authorizationLimitMs;
          const reportedExpiry = new Date(event.expiresAt).getTime();
          const transaction = providerLoginTransactionSchema.parse({
            transactionId,
            providerId,
            verificationUri: event.verificationUriComplete,
            userCode: event.userCode,
            expiresAt: new Date(Math.min(maximumExpiry, reportedExpiry)).toISOString(),
          });
          record.transaction = transaction;
          resolveReady(transaction);
        }
      },
    ).then(() => {
      this.removeLogin(record);
      if (!record.transaction) rejectReady(new MeegleAuthError("provider_login_failed"));
    }).catch(() => {
      this.removeLogin(record);
      if (!record.transaction) rejectReady(new MeegleAuthError("provider_login_failed"));
    });

    return ready;
  }

  async cancelLogin(transactionId: string): Promise<ProviderConnection> {
    const record = [...this.loginByProfile.values()]
      .find((candidate) => candidate.transactionId === transactionId);
    if (!record) {
      throw new MeegleAuthError("provider_login_transaction_not_found");
    }
    this.removeLogin(record);
    record.controller.abort();
    return connection("disconnected", { profileName: record.profileName });
  }

  async disconnect(): Promise<ProviderConnection> {
    if (this.loginByProfile.size > 0) {
      throw new MeegleAuthError("provider_authorization_in_progress");
    }
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

  private removeLogin(record: LoginRecord) {
    if (this.loginByProfile.get(record.profileName) !== record) return;
    clearTimeout(record.timer);
    this.loginByProfile.delete(record.profileName);
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
