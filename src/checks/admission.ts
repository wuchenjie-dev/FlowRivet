import type { GateFinding, GateResult } from "../domain/gate-result.js";
import type { Requirement } from "../domain/requirement.js";

const REQUIRED_TEXT_FIELDS = [
  ["targetUsers", "ADM-TARGET-USER-MISSING", "目标用户", "缺少目标用户"],
  ["scenario", "ADM-SCENARIO-MISSING", "使用场景", "缺少使用场景"],
  ["problem", "ADM-PROBLEM-MISSING", "当前问题", "缺少当前问题"],
  ["goal", "ADM-GOAL-MISSING", "需求目标", "缺少需求目标"],
  ["successMetrics", "ADM-METRIC-MISSING", "成功指标", "缺少可验证的成功指标"],
  ["scope", "ADM-SCOPE-MISSING", "范围", "缺少本次需求范围"],
  ["outOfScope", "ADM-OUT-OF-SCOPE-MISSING", "不做范围", "缺少明确的不做范围"],
] as const satisfies ReadonlyArray<
  readonly [
    keyof Requirement,
    string,
    string,
    string,
  ]
>;

export function checkRequirementAdmission(requirement: Requirement): GateResult {
  const findings: GateFinding[] = [];

  if (requirement.evidenceLinks.length === 0) {
    const requiresVoc = requirement.sourceType === "用户VOC";
    findings.push({
      code: requiresVoc ? "ADM-VOC-MISSING" : "ADM-EVIDENCE-MISSING",
      severity: "blocking",
      field: "证据链接",
      message: requiresVoc
        ? "用户需求必须提供可追溯的 VOC 证据"
        : `${requirement.sourceType}需求必须提供可追溯的替代证据`,
    });
  }

  for (const [property, code, field, message] of REQUIRED_TEXT_FIELDS) {
    if (typeof requirement[property] === "string" && requirement[property].trim() === "") {
      findings.push({ code, severity: "blocking", field, message });
    }
  }

  if (requirement.blockerQuestions.length > 0) {
    findings.push({
      code: "GATE-BLOCKING-QUESTION-OPEN",
      severity: "blocking",
      field: "阻断问题",
      message: `仍有 ${requirement.blockerQuestions.length} 个阻断问题未关闭`,
    });
  }

  return {
    passed: !findings.some((finding) => finding.severity === "blocking"),
    findings,
  };
}
