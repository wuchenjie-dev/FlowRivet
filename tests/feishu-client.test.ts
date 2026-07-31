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
});
