import type { TapdToken } from "./transactions.js";

export class TapdTokenExchangeError extends Error {
  readonly errorType = "tapd_token_exchange_failed";

  constructor(readonly upstreamStatus: number) {
    super(`TAPD token exchange failed (${upstreamStatus})`);
    this.name = "TapdTokenExchangeError";
  }
}

export async function exchangeTapdCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  callbackUri: string;
  fetch?: typeof globalThis.fetch;
}): Promise<TapdToken> {
  const request = input.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    redirect_uri: input.callbackUri,
    code: input.code,
  });
  const authorization = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");
  const response = await request("https://api.tapd.cn/tokens/request_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${authorization}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!response.ok) throw new TapdTokenExchangeError(response.status);
  const payload = (await response.json()) as {
    status?: number;
    info?: string;
    data?: {
      access_token?: string;
      expires_in?: number;
      scope?: string;
      resource?: {
        type?: string;
        user_id?: string | number;
        company_id?: string | number;
      };
    };
  };
  if (payload.status !== 1 || !payload.data?.access_token) {
    throw new TapdTokenExchangeError(response.status);
  }
  if (
    payload.data.resource?.type !== "user" ||
    !payload.data.resource.user_id ||
    !payload.data.resource.company_id
  ) {
    throw new Error("TAPD returned an unsupported OAuth resource");
  }
  return {
    accessToken: payload.data.access_token,
    expiresIn: payload.data.expires_in ?? 0,
    scope: payload.data.scope,
    resource: {
      type: "user",
      userId: String(payload.data.resource.user_id),
      companyId: String(payload.data.resource.company_id),
    },
  };
}
