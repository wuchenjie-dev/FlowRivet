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

export interface FeishuPocCardResult {
  dryRun: boolean;
  detail: string;
}

export interface FeishuNotifier {
  sendPocCard(options: { dryRun: boolean; chatId: string }): Promise<FeishuPocCardResult>;
}

export class FeishuClient implements FeishuMessagingProbe, FeishuNotifier {
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

  async sendPocCard(options: {
    dryRun: boolean;
    chatId: string;
  }): Promise<FeishuPocCardResult> {
    if (options.dryRun) {
      return { dryRun: true, detail: "POC card ready for configured test chat" };
    }

    const token = await this.getTenantToken();
    if (!token.ok) throw new Error(token.result.detail);
    const response = await this.fetcher(
      `${this.endpoint}/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.value}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: options.chatId,
          msg_type: "interactive",
          uuid: "flowrivet-poc-20260801-v1",
          content: JSON.stringify(buildPocCard()),
        }),
      },
    );
    const payload = (await response.json()) as { code: number; msg: string };
    if (!response.ok || payload.code !== 0) {
      throw new Error(
        `Feishu message send failed (${payload.code ?? response.status}): ${payload.msg ?? "unknown error"}`,
      );
    }
    return { dryRun: false, detail: "POC card sent" };
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

function buildPocCard(): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "FlowRivet POC 验证" },
    },
    elements: [
      {
        tag: "markdown",
        content:
          "**TAPD → FlowRivet → 飞书链路已就绪**\n\n" +
          "✅ 用户功能需求：准入通过\n" +
          "✅ 技术架构需求：准入通过\n" +
          "⛔ 跨模块需求：缺少成功指标，阻断问题未关闭\n\n" +
          "[打开 TAPD 沙箱](https://www.tapd.cn/tapd_fe/50396062/story/list)",
      },
    ],
  };
}
