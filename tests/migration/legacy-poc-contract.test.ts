import { describe, expect, it } from "vitest";

import { checkRequirementAdmission } from "../../src/checks/admission.js";
import { parseRequirement } from "../../src/domain/requirement.js";
import { buildAdmissionReminder } from "../../src/reminders/admission.js";
import { recordAdmissionReminder } from "../../src/tapd/reminder-record.js";

const blockedRequirement = parseRequirement({
  id: "story-42",
  workspaceId: "50396062",
  title: "跨模块需求",
  status: "待准入",
  sourceType: "产品规划",
  evidenceLinks: ["https://example.test/evidence/42"],
  targetUsers: "产品、研发和测试人员",
  scenario: "跨模块协作",
  problem: "缺少闭环",
  goal: "建立闭环",
  successMetrics: "",
  scope: "需求到代码追溯",
  outOfScope: "自动审批",
  owners: { product: "product", development: "developer", test: "tester" },
  blockerQuestions: ["确认异常场景"],
});

describe("legacy PoC migration contract", () => {
  it("keeps stable admission finding codes", () => {
    const result = checkRequirementAdmission(blockedRequirement);

    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "ADM-METRIC-MISSING",
      "GATE-BLOCKING-QUESTION-OPEN",
    ]);
  });

  it("keeps reminder recording dry-run by default", async () => {
    const comments: string[] = [];
    const reminder = buildAdmissionReminder({
      requirement: blockedRequirement,
      admission: checkRequirementAdmission(blockedRequirement),
      binding: { tapdUser: "product", feishuOpenId: "ou_secret" },
    });

    const result = await recordAdmissionReminder(
      {
        listRequirementComments: async () => comments,
        addRequirementComment: async ({ description }) => {
          comments.push(description);
        },
      },
      reminder,
      { dryRun: true, author: "product" },
    );

    expect(result.dryRun).toBe(true);
    expect(comments).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("ou_secret");
  });
});
