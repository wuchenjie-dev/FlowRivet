import { parseRequirement, type Requirement } from "../domain/requirement.js";
import type { CustomField } from "./fields.js";

const FIELD_NAMES = {
  sourceType: "需求来源类型",
  evidenceLinks: "证据链接",
  targetUsers: "目标用户",
  scenario: "使用场景",
  problem: "当前问题",
  goal: "需求目标",
  successMetrics: "成功指标",
  scope: "范围",
  outOfScope: "不做范围",
  productOwner: "产品负责人",
  developmentOwner: "研发负责人",
  testOwner: "测试负责人",
  blockerQuestions: "阻断问题",
} as const;

export type RequirementFieldMapping = Record<keyof typeof FIELD_NAMES, string>;

export function buildFieldMapping(fields: CustomField[]): RequirementFieldMapping {
  const identifiers = new Map(fields.map((field) => [field.name, field.field]));
  return Object.fromEntries(
    Object.entries(FIELD_NAMES).map(([logicalName, displayName]) => {
      const identifier = identifiers.get(displayName);
      if (!identifier) throw new Error(`Missing required TAPD field: ${displayName}`);
      return [logicalName, identifier];
    }),
  ) as RequirementFieldMapping;
}

export function mapTapdStory(
  story: Record<string, unknown>,
  fields: RequirementFieldMapping,
): Requirement {
  return parseRequirement({
    id: text(story.id),
    workspaceId: text(story.workspace_id),
    title: text(story.name),
    status: text(story.status),
    sourceType: text(story[fields.sourceType]),
    evidenceLinks: lines(story[fields.evidenceLinks]),
    targetUsers: text(story[fields.targetUsers]),
    scenario: text(story[fields.scenario]),
    problem: text(story[fields.problem]),
    goal: text(story[fields.goal]),
    successMetrics: text(story[fields.successMetrics]),
    scope: text(story[fields.scope]),
    outOfScope: text(story[fields.outOfScope]),
    owners: {
      product: text(story[fields.productOwner]),
      development: text(story[fields.developmentOwner]),
      test: text(story[fields.testOwner]),
    },
    blockerQuestions: lines(story[fields.blockerQuestions]),
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function lines(value: unknown): string[] {
  return text(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
