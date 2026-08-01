import { describe, expect, it, vi } from "vitest";

import { FeishuClient } from "../src/feishu/client.js";
import type { AdmissionReminderPlan } from "../src/reminders/admission.js";

const reminder: AdmissionReminderPlan = {
  requirementId: "1150396062001000019",
  title: "[FLOWRIVET_POC] 跨模块：ABF 检测结果闭环",
  requirementUrl: "https://www.tapd.cn/50396062/prong/stories/view/1150396062001000019",
  recipientOpenId: "ou_test_user",
  findings: [
    { code: "ADM-METRIC-MISSING", message: "缺少可度量的成功指标" },
    { code: "GATE-BLOCKING-QUESTION-OPEN", message: "仍有 1 个阻断问题未关闭" },
  ],
};

describe("FeishuClient", () => {
  it("authenticates a self-built application without exposing the token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code: 0,
      msg: "ok",
      tenant_access_token: "tenant-secret-token",
      expire: 7200,
    }));
    const client = new FeishuClient({
      endpoint: "https://open.feishu.cn/open-apis",
      appId: "cli_test",
      appSecret: "app-secret",
      fetcher,
    });

    const result = await client.checkAccess();

    expect(result).toEqual({ ok: true, detail: "Feishu app authenticated; token expires in 7200s" });
    expect(JSON.stringify(result)).not.toContain("tenant-secret-token");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    );
  });

  it("returns a sanitized authentication failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code: 10003,
      msg: "invalid app secret",
    }));
    const client = new FeishuClient({
      endpoint: "https://open.feishu.cn/open-apis",
      appId: "cli_test",
      appSecret: "app-secret",
      fetcher,
    });

    const result = await client.checkAccess();

    expect(result).toEqual({ ok: false, detail: "Feishu access failed (10003): invalid app secret" });
    expect(JSON.stringify(result)).not.toContain("app-secret");
  });

  it("checks bot chat visibility without returning chat data", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        code: 0, msg: "ok", tenant_access_token: "tenant-secret-token", expire: 7200,
      }))
      .mockResolvedValueOnce(Response.json({
        code: 0, msg: "ok", data: { items: [{ chat_id: "oc_secret", name: "私密测试群" }] },
      }));
    const client = new FeishuClient({
      endpoint: "https://open.feishu.cn/open-apis",
      appId: "cli_test",
      appSecret: "app-secret",
      fetcher,
    });

    const result = await client.checkMessagingAccess();

    expect(result).toEqual({ ok: true, detail: "Feishu bot can access 1 chat(s)" });
    expect(JSON.stringify(result)).not.toContain("oc_secret");
    const headers = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer tenant-secret-token");
  });

  it("reports missing messaging permission without exposing credentials", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        code: 0, msg: "ok", tenant_access_token: "tenant-secret-token", expire: 7200,
      }))
      .mockResolvedValueOnce(Response.json({
        code: 99991672, msg: "Access denied. One of the following scopes is required",
      }));
    const client = new FeishuClient({
      endpoint: "https://open.feishu.cn/open-apis",
      appId: "cli_test",
      appSecret: "app-secret",
      fetcher,
    });

    const result = await client.checkMessagingAccess();

    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain("99991672");
    expect(JSON.stringify(result)).not.toContain("tenant-secret-token");
  });

  it("previews a POC card without calling Feishu", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new FeishuClient({
      endpoint: "https://open.feishu.cn/open-apis",
      appId: "cli_test",
      appSecret: "app-secret",
      fetcher,
    });

    const result = await client.sendPocCard({ dryRun: true, chatId: "oc_secret" });

    expect(result).toEqual({
      dryRun: true,
      detail: "POC card ready for configured test chat",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("oc_secret");
  });

  it("sends a card with a stable idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        code: 0, msg: "ok", tenant_access_token: "tenant-secret-token", expire: 7200,
      }))
      .mockResolvedValueOnce(Response.json({
        code: 0, msg: "ok", data: { message_id: "om_secret" },
      }));
    const client = new FeishuClient({
      endpoint: "https://open.feishu.cn/open-apis",
      appId: "cli_test",
      appSecret: "app-secret",
      fetcher,
    });

    const result = await client.sendPocCard({ dryRun: false, chatId: "oc_secret" });

    expect(result).toEqual({ dryRun: false, detail: "POC card sent" });
    const url = String(fetcher.mock.calls[1]?.[0]);
    expect(url).toContain("receive_id_type=chat_id");
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as {
      receive_id: string;
      uuid: string;
    };
    expect(body.receive_id).toBe("oc_secret");
    expect(body.uuid).toBe("flowrivet-poc-20260801-v1");
    expect(JSON.stringify(result)).not.toContain("om_secret");
  });

  it("previews a blocker reminder without calling Feishu or exposing the Open ID", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new FeishuClient({
      endpoint: "https://open.feishu.cn/open-apis",
      appId: "cli_test",
      appSecret: "app-secret",
      fetcher,
    });

    const result = await client.sendAdmissionReminder({
      dryRun: true,
      chatId: "oc_secret",
      reminder,
    });

    expect(result).toEqual({
      dryRun: true,
      detail: "Blocker reminder ready for configured test chat",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("ou_test_user");
  });

  it("sends an attributed blocker card with a stable state-based idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        code: 0, msg: "ok", tenant_access_token: "tenant-secret-token", expire: 7200,
      }))
      .mockResolvedValueOnce(Response.json({
        code: 0, msg: "ok", data: { message_id: "om_secret" },
      }));
    const client = new FeishuClient({
      endpoint: "https://open.feishu.cn/open-apis",
      appId: "cli_test",
      appSecret: "app-secret",
      fetcher,
    });

    const result = await client.sendAdmissionReminder({
      dryRun: false,
      chatId: "oc_secret",
      reminder,
    });

    expect(result).toEqual({ dryRun: false, detail: "Blocker reminder sent" });
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as {
      uuid: string;
      content: string;
    };
    const card = JSON.parse(body.content) as { elements: Array<{ content?: string }> };
    expect(body.uuid).toMatch(/^flowrivet-admission-[a-f0-9]{24}$/);
    expect(card.elements[0]?.content).toContain('<at id="ou_test_user"></at>');
    expect(card.elements[0]?.content).toContain("ADM-METRIC-MISSING");
    expect(card.elements[0]?.content).toContain(reminder.requirementUrl);
  });
});
