import { describe, expect, it } from "vitest";

import { buildFieldMapping, mapTapdStory } from "../src/tapd/mapper.js";

const customFields = [
  { name: "需求来源类型", field: "custom_field_one", type: "select", options: [], enabled: true },
  { name: "证据链接", field: "custom_field_two", type: "textarea", options: [], enabled: true },
  { name: "目标用户", field: "custom_field_three", type: "textarea", options: [], enabled: true },
  { name: "使用场景", field: "custom_field_four", type: "textarea", options: [], enabled: true },
  { name: "当前问题", field: "custom_field_five", type: "textarea", options: [], enabled: true },
  { name: "需求目标", field: "custom_field_six", type: "textarea", options: [], enabled: true },
  { name: "成功指标", field: "custom_field_seven", type: "textarea", options: [], enabled: true },
  { name: "范围", field: "custom_field_eight", type: "textarea", options: [], enabled: true },
  { name: "不做范围", field: "custom_field_9", type: "textarea", options: [], enabled: true },
  { name: "产品负责人", field: "custom_field_10", type: "user_chooser", options: [], enabled: true },
  { name: "研发负责人", field: "custom_field_11", type: "user_chooser", options: [], enabled: true },
  { name: "测试负责人", field: "custom_field_12", type: "user_chooser", options: [], enabled: true },
  { name: "阻断问题", field: "custom_field_13", type: "textarea", options: [], enabled: true },
];

describe("TAPD requirement mapping", () => {
  it("builds project-specific identifiers from field names", () => {
    const mapping = buildFieldMapping(customFields);

    expect(mapping.sourceType).toBe("custom_field_one");
    expect(mapping.testOwner).toBe("custom_field_12");
  });

  it("maps a TAPD story without hard-coded custom field identifiers", () => {
    const mapping = buildFieldMapping(customFields);
    const requirement = mapTapdStory(
      {
        id: "1150396062001000001",
        workspace_id: "50396062",
        name: "支持 ABF 规则配置",
        status: "草稿",
        custom_field_one: "用户VOC",
        custom_field_two: "https://example.test/voc/1\nhttps://example.test/data/1",
        custom_field_three: "平台管理员",
        custom_field_four: "管理员维护检测规则",
        custom_field_five: "规则只能通过代码发布",
        custom_field_six: "允许管理员安全配置规则",
        custom_field_seven: "配置成功率达到 99%",
        custom_field_eight: "规则创建与校验",
        custom_field_9: "自动生成全部规则",
        custom_field_10: "product-user",
        custom_field_11: "developer-user",
        custom_field_12: "tester-user",
        custom_field_13: "",
      },
      mapping,
    );

    expect(requirement.evidenceLinks).toHaveLength(2);
    expect(requirement.owners.development).toBe("developer-user");
  });

  it("fails when the project is missing a required FlowRivet field", () => {
    expect(() => buildFieldMapping(customFields.slice(1))).toThrow(
      /需求来源类型/,
    );
  });
});
