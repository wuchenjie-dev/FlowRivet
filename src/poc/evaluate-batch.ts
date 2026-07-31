import { checkRequirementAdmission } from "../checks/admission.js";
import type { GateFinding } from "../domain/gate-result.js";
import type { CustomField } from "../tapd/fields.js";
import { buildFieldMapping, mapTapdStory } from "../tapd/mapper.js";

export interface AdmissionBatchItem {
  id: string;
  title: string;
  passed: boolean;
  findings: GateFinding[];
}

export interface AdmissionBatchReport {
  total: number;
  passed: number;
  blocked: number;
  results: AdmissionBatchItem[];
}

export function evaluateAdmissionBatch(
  stories: Array<Record<string, unknown>>,
  customFields: CustomField[],
): AdmissionBatchReport {
  const mapping = buildFieldMapping(customFields);
  const results = stories.map((story) => {
    const requirement = mapTapdStory(story, mapping);
    const gate = checkRequirementAdmission(requirement);
    return {
      id: requirement.id,
      title: requirement.title,
      passed: gate.passed,
      findings: gate.findings,
    };
  });
  const passed = results.filter((result) => result.passed).length;

  return {
    total: results.length,
    passed,
    blocked: results.length - passed,
    results,
  };
}
