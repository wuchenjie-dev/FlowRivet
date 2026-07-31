import { describe, expect, it, vi } from "vitest";

import { TapdReadClient } from "../src/tapd/read-client.js";

const fieldResponse = {
  status: 1,
  info: "success",
  data: [
    ["需求来源类型", "custom_field_one"],
    ["证据链接", "custom_field_two"],
    ["目标用户", "custom_field_three"],
    ["使用场景", "custom_field_four"],
    ["当前问题", "custom_field_five"],
    ["需求目标", "custom_field_six"],
    ["成功指标", "custom_field_seven"],
    ["范围", "custom_field_eight"],
    ["不做范围", "custom_field_9"],
    ["产品负责人", "custom_field_10"],
    ["研发负责人", "custom_field_11"],
    ["测试负责人", "custom_field_12"],
    ["阻断问题", "custom_field_13"],
  ].map(([name, custom_field]) => ({
    CustomFieldConfig: { name, custom_field, type: "textarea", options: "[]", enabled: "1" },
  })),
};

function story(id: string) {
  return {
    Story: {
      id,
      workspace_id: "50396062",
      name: `需求 ${id}`,
      status: "待准入",
      custom_field_one: "技术",
      custom_field_two: "https://example.test/evidence/1",
      custom_field_three: "平台管理员",
      custom_field_four: "维护规则",
      custom_field_five: "发布成本高",
      custom_field_six: "降低发布成本",
      custom_field_seven: "配置成功率 99%",
      custom_field_eight: "规则配置",
      custom_field_9: "自动生成规则",
      custom_field_10: "product-user",
      custom_field_11: "developer-user",
      custom_field_12: "tester-user",
      custom_field_13: "",
    },
  };
}

describe("TapdReadClient", () => {
  it("reads and maps all pages with personal Bearer authentication", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(fieldResponse))
      .mockResolvedValueOnce(Response.json({ status: 1, info: "success", data: [story("1"), story("2")] }))
      .mockResolvedValueOnce(Response.json({ status: 1, info: "success", data: [story("3")] }));
    const client = new TapdReadClient({
      endpoint: "https://api.tapd.cn",
      workspaceId: "50396062",
      personalToken: "personal-token",
      pageSize: 2,
      fetcher,
    });

    const requirements = await client.listRequirements();

    expect(requirements.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const headers = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer personal-token");
  });

  it("gets and maps one requirement by id", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(fieldResponse))
      .mockResolvedValueOnce(Response.json({ status: 1, info: "success", data: [story("42")] }));
    const client = new TapdReadClient({
      endpoint: "https://api.tapd.cn",
      workspaceId: "50396062",
      personalToken: "personal-token",
      fetcher,
    });

    const requirement = await client.getRequirement("42");

    expect(requirement.id).toBe("42");
  });

  it("fails when a requested requirement does not exist", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(fieldResponse))
      .mockResolvedValueOnce(Response.json({ status: 1, info: "success", data: [] }));
    const client = new TapdReadClient({
      endpoint: "https://api.tapd.cn",
      workspaceId: "50396062",
      personalToken: "personal-token",
      fetcher,
    });

    await expect(client.getRequirement("missing")).rejects.toThrow(/not found/);
  });
});
