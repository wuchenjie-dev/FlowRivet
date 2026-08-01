import { describe, expect, it } from "vitest";

import { checkRequirementAdmission } from "../src/checks/admission.js";
import { parseRequirement } from "../src/domain/requirement.js";
import { buildAdmissionReminder } from "../src/reminders/admission.js";

const blockedRequirement = parseRequirement({
  id: "1150396062001000019",
  workspaceId: "50396062",
  title: "[FLOWRIVET_POC] 跨模块：ABF 检测结果闭环",
  status: "规划中",
  sourceType: "产品规划",
  evidenceLinks: ["https://example.test/plan/poc-cross-1"],
  targetUsers: "产品、研发和测试人员",
  scenario: "检测问题需要跨模块协同关闭",
  problem: "问题无法形成统一追踪链",
  goal: "建立问题到交付的闭环",
  successMetrics: "",
  scope: "TAPD、飞书和 GitLab 追溯",
  outOfScope: "自动替代人工审批",
  owners: {
    product: "wuchenjie",
    development: "wuchenjie",
    test: "wuchenjie",
  },
  blockerQuestions: ["确认跨企业身份映射策略"],
});

describe("buildAdmissionReminder", () => {
  it("builds a reminder for a blocked requirement and explicitly bound owner", () => {
    const plan = buildAdmissionReminder({
      requirement: blockedRequirement,
      admission: checkRequirementAdmission(blockedRequirement),
      binding: { tapdUser: "wuchenjie", feishuOpenId: "ou_1234567890abcdef" },
    });

    expect(plan.findings).toHaveLength(2);
    expect(plan.recipientOpenId).toBe("ou_1234567890abcdef");
    expect(plan.requirementUrl).toContain("1150396062001000019");
  });

  it("rejects a reminder when the requirement owner is not explicitly bound", () => {
    expect(() =>
      buildAdmissionReminder({
        requirement: blockedRequirement,
        admission: checkRequirementAdmission(blockedRequirement),
        binding: { tapdUser: "another-user", feishuOpenId: "ou_1234567890abcdef" },
      }),
    ).toThrow("No explicit identity binding for requirement owners");
  });
});
