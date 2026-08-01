import { describe, expect, it, vi } from "vitest";

import { FeishuClient } from "../src/feishu/client.js";

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
});
