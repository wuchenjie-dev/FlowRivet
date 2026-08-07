import {
  CredentialStoreError,
  type CredentialStore,
} from "./credential-store.js";
import {
  TapdIdentityError,
  type TapdIdentity,
  type TapdIdentityValidator,
} from "./tapd-identity-client.js";
import type { AuthErrorCode, AuthResult } from "../contracts/auth.js";

export interface TapdAuthenticator {
  login(token: string): Promise<AuthResult>;
  getConnectionStatus(): Promise<AuthResult>;
  disconnect(): Promise<AuthResult>;
}

export class TapdAuthService implements TapdAuthenticator {
  constructor(private readonly options: {
    store: CredentialStore;
    identityClient: TapdIdentityValidator;
  }) {}

  async login(token: string): Promise<AuthResult> {
    const normalized = token.trim();
    if (!normalized) return failure("invalid_token", "disconnected");
    try {
      const identity = await this.options.identityClient.validate(normalized);
      await this.options.store.writeTapdToken(normalized);
      return success(identity);
    } catch (error) {
      return mapFailure(error, "disconnected");
    }
  }

  async getConnectionStatus(): Promise<AuthResult> {
    let token: string | undefined;
    try {
      token = await this.options.store.readTapdToken();
    } catch (error) {
      return mapFailure(error, "disconnected");
    }
    if (!token) {
      return { ok: true, connection: { tapd: "disconnected" } };
    }
    try {
      return success(await this.options.identityClient.validate(token));
    } catch (error) {
      const state = error instanceof TapdIdentityError && error.code === "invalid_token"
        ? "expired"
        : "disconnected";
      return mapFailure(error, state);
    }
  }

  async disconnect(): Promise<AuthResult> {
    try {
      await this.options.store.deleteTapdToken();
      return { ok: true, connection: { tapd: "disconnected" } };
    } catch (error) {
      return mapFailure(error, "disconnected");
    }
  }
}

function success(identity: TapdIdentity): AuthResult {
  return {
    ok: true,
    connection: {
      tapd: "connected",
      userName: identity.userName,
      ...(identity.companyName ? { companyName: identity.companyName } : {}),
    },
  };
}

function mapFailure(
  error: unknown,
  tapd: "disconnected" | "expired",
): AuthResult {
  if (error instanceof TapdIdentityError || error instanceof CredentialStoreError) {
    return failure(error.code, tapd);
  }
  return failure("credential_store_failed", tapd);
}

function failure(
  errorCode: AuthErrorCode,
  tapd: "disconnected" | "expired",
): AuthResult {
  return { ok: false, errorCode, connection: { tapd } };
}
