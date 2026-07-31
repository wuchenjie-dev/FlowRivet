import { describe, expect, it, vi } from "vitest";

import { TapdClient } from "../src/tapd/client.js";

describe("TapdClient", () => {
  it("uses Basic authentication for administrator field operations", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 1, data: [], info: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = TapdClient.forAdmin({
      endpoint: "https://api.tapd.cn",
      workspaceId: "50396062",
      apiUser: "api-user",
      apiPassword: "api-password",
      fetcher,
    });

    await client.listCustomFields();

    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toMatch(/^Basic /);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.tapd.cn/stories/custom_fields_settings?workspace_id=50396062",
    );
  });

  it("raises a sanitized error for TAPD permission failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ status: 403, data: "", info: "project forbidden" }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    const client = TapdClient.forAdmin({
      endpoint: "https://api.tapd.cn",
      workspaceId: "50396062",
      apiUser: "api-user",
      apiPassword: "api-password",
      fetcher,
    });

    await expect(client.listCustomFields()).rejects.toThrow(
      "TAPD request failed (403): project forbidden",
    );
  });
});
