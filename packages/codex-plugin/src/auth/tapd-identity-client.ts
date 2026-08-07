import type { AuthErrorCode } from "../contracts/auth.js";

export interface TapdIdentity {
  userName: string;
  companyName?: string;
  companyId?: string;
}

export interface TapdIdentityValidator {
  validate(token: string): Promise<TapdIdentity>;
}

export class TapdIdentityError extends Error {
  constructor(readonly code: Extract<
    AuthErrorCode,
    "invalid_token" | "permission_denied" | "tapd_unavailable"
  >) {
    super(code);
    this.name = "TapdIdentityError";
  }
}

export class TapdIdentityClient implements TapdIdentityValidator {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { endpoint?: string; fetcher?: typeof fetch } = {}) {
    this.endpoint = (options.endpoint ?? "https://api.tapd.cn").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async validate(token: string): Promise<TapdIdentity> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint}/users/info`, {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      throw new TapdIdentityError("tapd_unavailable");
    }

    if (response.status === 401) throw new TapdIdentityError("invalid_token");
    if (response.status === 403) throw new TapdIdentityError("permission_denied");
    if (!response.ok) throw new TapdIdentityError("tapd_unavailable");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TapdIdentityError("tapd_unavailable");
    }
    const envelope = asRecord(payload);
    if (envelope.status !== 1) throw new TapdIdentityError("invalid_token");

    const identity = parseIdentity(envelope.data);
    if (!identity) throw new TapdIdentityError("permission_denied");
    return identity;
  }
}

function parseIdentity(value: unknown): TapdIdentity | undefined {
  const data = Array.isArray(value) ? value[0] : value;
  const wrapper = asRecord(data);
  const user = asRecord(wrapper.User ?? wrapper.user ?? data);
  const userName = firstString(user, ["name", "user_name", "nick"]);
  const companyId = firstString(user, ["company_id", "companyId"]);
  const companyName = firstString(user, ["company_name", "companyName"])
    ?? companyId;
  if (!userName) return undefined;
  return {
    userName,
    ...(companyName ? { companyName } : {}),
    ...(companyId ? { companyId } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}
