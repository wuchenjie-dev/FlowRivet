import type { ProbeResult } from "../doctor.js";

interface FeishuClientOptions {
  endpoint: string;
  appId: string;
  appSecret: string;
  fetcher?: typeof fetch;
}

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface ChatListResponse {
  code: number;
  msg: string;
  data?: { items?: unknown[] };
}

export interface FeishuMessagingProbe {
  checkMessagingAccess(): Promise<ProbeResult>;
}

export class FeishuClient implements FeishuMessagingProbe {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: FeishuClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async checkAccess(): Promise<ProbeResult> {
    const token = await this.getTenantToken();
    if (!token.ok) return token.result;
    return {
      ok: true,
      detail: `Feishu app authenticated; token expires in ${token.expire}s`,
    };
  }

  async checkMessagingAccess(): Promise<ProbeResult> {
    const token = await this.getTenantToken();
    if (!token.ok) return token.result;
    try {
      const response = await this.fetcher(`${this.endpoint}/im/v1/chats?page_size=100`, {
        headers: { authorization: `Bearer ${token.value}` },
      });
      const payload = (await response.json()) as ChatListResponse;
      if (!response.ok || payload.code !== 0) {
        return {
          ok: false,
          detail: `Feishu messaging access failed (${payload.code ?? response.status}): ${payload.msg ?? "unknown error"}`,
        };
      }
      return {
        ok: true,
        detail: `Feishu bot can access ${payload.data?.items?.length ?? 0} chat(s)`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `Feishu messaging access failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }

  private async getTenantToken(): Promise<
    | { ok: true; value: string; expire: number }
    | { ok: false; result: ProbeResult }
  > {
    try {
      const response = await this.fetcher(
        `${this.endpoint}/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            app_id: this.options.appId,
            app_secret: this.options.appSecret,
          }),
        },
      );
      const payload = (await response.json()) as TenantTokenResponse;
      if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
        return { ok: false, result: {
          ok: false,
          detail: `Feishu access failed (${payload.code ?? response.status}): ${payload.msg ?? "unknown error"}`,
        } };
      }
      return {
        ok: true,
        value: payload.tenant_access_token,
        expire: payload.expire ?? 0,
      };
    } catch (error) {
      return { ok: false, result: {
        ok: false,
        detail: `Feishu access failed: ${error instanceof Error ? error.message : "unknown error"}`,
      } };
    }
  }
}
