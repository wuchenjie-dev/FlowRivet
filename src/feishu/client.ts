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

export class FeishuClient {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: FeishuClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async checkAccess(): Promise<ProbeResult> {
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
        return {
          ok: false,
          detail: `Feishu access failed (${payload.code ?? response.status}): ${payload.msg ?? "unknown error"}`,
        };
      }
      return {
        ok: true,
        detail: `Feishu app authenticated; token expires in ${payload.expire ?? 0}s`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `Feishu access failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }
}
