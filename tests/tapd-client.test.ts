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

  it("finds only an exact story title", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: 1,
        info: "success",
        data: [
          { Story: { id: "1", name: "[FLOWRIVET_POC] 用户功能" } },
          { Story: { id: "2", name: "[FLOWRIVET_POC] 用户功能扩展" } },
        ],
      }),
    );
    const client = TapdClient.forAdmin({
      endpoint: "https://api.tapd.cn",
      workspaceId: "50396062",
      apiUser: "api-user",
      apiPassword: "api-password",
      fetcher,
    });

    const story = await client.findStoryByExactTitle("[FLOWRIVET_POC] 用户功能");

    expect(story).toEqual({ id: "1" });
  });

  it("creates a story with dynamic custom fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: 1,
        info: "success",
        data: { Story: { id: "100" } },
      }),
    );
    const client = TapdClient.forAdmin({
      endpoint: "https://api.tapd.cn",
      workspaceId: "50396062",
      apiUser: "api-user",
      apiPassword: "api-password",
      fetcher,
    });

    await client.createStory({
      name: "[FLOWRIVET_POC] 用户功能",
      owner: "wuchenjie",
      fields: { custom_field_one: "用户VOC" },
    });

    const body = fetcher.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("workspace_id")).toBe("50396062");
    expect(body.get("custom_field_one")).toBe("用户VOC");
  });

  it("reads a sandbox story as a requirement", async () => {
    const fieldNames = [
      "需求来源类型", "证据链接", "目标用户", "使用场景", "当前问题", "需求目标", "成功指标",
      "范围", "不做范围", "产品负责人", "研发负责人", "测试负责人", "阻断问题",
    ];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        status: 1, info: "success",
        data: fieldNames.map((name, index) => ({ CustomFieldConfig: {
          name, type: "text", options: null,
          custom_field: `custom_field_${index + 1}`, enabled: "1",
        } })),
      }))
      .mockResolvedValueOnce(Response.json({
        status: 1, info: "success",
        data: [{ Story: {
          id: "100", workspace_id: "50396062", name: "[FLOWRIVET_POC] 用户功能", status: "规划中",
          custom_field_1: "用户VOC", custom_field_2: "https://example.test/voc/100",
          custom_field_3: "业务管理员", custom_field_4: "配置检测规则", custom_field_5: "学习成本高",
          custom_field_6: "降低配置门槛", custom_field_7: "成功率达到 90%", custom_field_8: "规则配置",
          custom_field_9: "自动发布", custom_field_10: "product", custom_field_11: "developer",
          custom_field_12: "tester", custom_field_13: "",
        } }],
      }));
    const client = TapdClient.forAdmin({
      endpoint: "https://api.tapd.cn", workspaceId: "50396062",
      apiUser: "api-user", apiPassword: "api-password", fetcher,
    });

    const requirement = await client.getRequirement("100");

    expect(requirement.id).toBe("100");
    expect(requirement.sourceType).toBe("用户VOC");
    expect(fetcher.mock.calls[1]?.[0]).toContain("id=100");
  });
});
