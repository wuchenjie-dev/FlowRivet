import { describe, expect, it } from "vitest";

import { parseRequirement } from "../src/domain/requirement.js";

const completeRequirement = {
  id: "1150396062001000001",
  workspaceId: "50396062",
  title: "支持 ABF 规则配置",
  status: "草稿",
  sourceType: "用户VOC",
  evidenceLinks: ["https://example.test/voc/1"],
  targetUsers: "平台管理员",
  scenario: "管理员维护检测规则",
  problem: "规则只能通过代码发布",
  goal: "允许管理员安全配置规则",
  successMetrics: "配置成功率达到 99%",
  scope: "规则创建与校验",
  outOfScope: "自动生成全部规则",
  owners: {
    product: "product-user",
    development: "developer-user",
    test: "tester-user",
  },
  blockerQuestions: [],
};

describe("parseRequirement", () => {
  it("accepts a complete requirement", () => {
    expect(parseRequirement(completeRequirement)).toMatchObject({
      id: "1150396062001000001",
      sourceType: "用户VOC",
    });
  });

  it.each(["id", "title", "status"] as const)("rejects a missing %s", (field) => {
    expect(() => parseRequirement({ ...completeRequirement, [field]: "" })).toThrow();
  });

  it("rejects an unknown source type", () => {
    expect(() =>
      parseRequirement({ ...completeRequirement, sourceType: "拍脑袋需求" }),
    ).toThrow(/sourceType/);
  });

  it("requires product, development, and test owners", () => {
    expect(() =>
      parseRequirement({
        ...completeRequirement,
        owners: { ...completeRequirement.owners, test: "" },
      }),
    ).toThrow();
  });
});
