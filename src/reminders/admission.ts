import type { GateResult } from "../domain/gate-result.js";
import type { Requirement } from "../domain/requirement.js";
import type { IdentityBinding } from "../identity/binding.js";

export interface AdmissionReminderPlan {
  requirementId: string;
  title: string;
  requirementUrl: string;
  recipientOpenId: string;
  findings: Array<{ code: string; message: string }>;
}

export function buildAdmissionReminder(input: {
  requirement: Requirement;
  admission: GateResult;
  binding: IdentityBinding;
}): AdmissionReminderPlan {
  if (input.admission.passed || input.admission.findings.length === 0) {
    throw new Error("Admission reminder requires a blocked requirement");
  }

  const owners = Object.values(input.requirement.owners);
  if (!owners.includes(input.binding.tapdUser)) {
    throw new Error("No explicit identity binding for requirement owners");
  }

  return {
    requirementId: input.requirement.id,
    title: input.requirement.title,
    requirementUrl:
      `https://www.tapd.cn/${input.requirement.workspaceId}/prong/stories/view/${input.requirement.id}`,
    recipientOpenId: input.binding.feishuOpenId,
    findings: input.admission.findings.map(({ code, message }) => ({ code, message })),
  };
}
