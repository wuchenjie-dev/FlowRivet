import { describe, expect, it } from "vitest";

import { checkRequirementAdmission } from "../src/checks/admission.js";
import { parseRequirement } from "../src/domain/requirement.js";

function requirement(overrides: Record<string, unknown> = {}) {
  return parseRequirement({
    id: "1150396062001000001",
    workspaceId: "50396062",
    title: "支持 ABF 规则配置",
    status: "待准入",
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
    ...overrides,
  });
}

describe("checkRequirementAdmission", () => {
  it("passes a complete user requirement with VOC evidence", () => {
    const result = checkRequirementAdmission(requirement());

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("blocks a user requirement without VOC evidence", () => {
    const result = checkRequirementAdmission(requirement({ evidenceLinks: [] }));

    expect(result.passed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "ADM-VOC-MISSING", severity: "blocking" }),
    );
  });

  it("accepts technical evidence instead of VOC", () => {
    const result = checkRequirementAdmission(
      requirement({
        sourceType: "技术",
        evidenceLinks: ["https://example.test/performance/1"],
      }),
    );

    expect(result.passed).toBe(true);
  });

  it("blocks a technical requirement without alternative evidence", () => {
    const result = checkRequirementAdmission(
      requirement({ sourceType: "技术", evidenceLinks: [] }),
    );

    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "ADM-EVIDENCE-MISSING" }),
    );
    expect(result.findings.map((finding) => finding.code)).not.toContain(
      "ADM-VOC-MISSING",
    );
  });

  it("reports stable codes for missing admission fields", () => {
    const result = checkRequirementAdmission(
      requirement({
        targetUsers: "",
        scenario: "",
        problem: "",
        goal: "",
        successMetrics: "",
        scope: "",
        outOfScope: "",
      }),
    );

    expect(result.findings.map((finding) => finding.code)).toEqual([
      "ADM-TARGET-USER-MISSING",
      "ADM-SCENARIO-MISSING",
      "ADM-PROBLEM-MISSING",
      "ADM-GOAL-MISSING",
      "ADM-METRIC-MISSING",
      "ADM-SCOPE-MISSING",
      "ADM-OUT-OF-SCOPE-MISSING",
    ]);
  });

  it("blocks admission while blocking questions remain open", () => {
    const result = checkRequirementAdmission(
      requirement({ blockerQuestions: ["需要确认数据保留周期"] }),
    );

    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "GATE-BLOCKING-QUESTION-OPEN" }),
    );
  });
});
