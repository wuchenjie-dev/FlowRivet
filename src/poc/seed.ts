import type { CustomField } from "../tapd/fields.js";
import { buildFieldMapping } from "../tapd/mapper.js";

export interface PocStoryInput {
  name: string;
  owner: string;
  fields: Record<string, string>;
}

export interface PocStoryAdmin {
  listCustomFields(): Promise<CustomField[]>;
  findStoryByExactTitle(title: string): Promise<{ id: string } | undefined>;
  createStory(input: PocStoryInput): Promise<{ id: string }>;
}

interface PocRequirementDefinition {
  title: string;
  sourceType: string;
  evidenceLinks: string;
  targetUsers: string;
  scenario: string;
  problem: string;
  goal: string;
  successMetrics: string;
  scope: string;
  outOfScope: string;
  blockerQuestions: string;
}

export const POC_REQUIREMENTS: readonly PocRequirementDefinition[] = [
  {
    title: "[FLOWRIVET_POC] 用户功能：自然语言配置检测规则",
    sourceType: "用户VOC",
    evidenceLinks: "https://example.test/voc/poc-user-1",
    targetUsers: "业务管理员",
    scenario: "管理员用自然语言创建检测规则",
    problem: "现有配置学习成本高",
    goal: "降低规则配置门槛",
    successMetrics: "首次配置成功率达到 90%",
    scope: "规则生成、预览和确认",
    outOfScope: "自动发布高风险规则",
    blockerQuestions: "",
  },
  {
    title: "[FLOWRIVET_POC] 技术架构：动态 Prompt 注入隔离",
    sourceType: "技术",
    evidenceLinks: "https://example.test/performance/poc-tech-1",
    targetUsers: "平台研发人员",
    scenario: "多租户运行不同检测策略",
    problem: "当前注入方式存在串扰风险",
    goal: "实现租户级 Prompt 隔离",
    successMetrics: "串扰测试 100% 通过",
    scope: "运行时装载、隔离和审计",
    outOfScope: "替换全部历史 Prompt",
    blockerQuestions: "",
  },
  {
    title: "[FLOWRIVET_POC] 跨模块：ABF 检测结果闭环",
    sourceType: "产品规划",
    evidenceLinks: "https://example.test/plan/poc-cross-1",
    targetUsers: "产品、研发和测试人员",
    scenario: "检测问题需要跨模块协同关闭",
    problem: "问题无法形成统一追踪链",
    goal: "建立问题到交付的闭环",
    successMetrics: "",
    scope: "TAPD、飞书和 GitLab 追溯",
    outOfScope: "自动替代人工审批",
    blockerQuestions: "确认跨企业身份映射策略",
  },
];

export interface PocSeedResult {
  planned: string[];
  created: Array<{ title: string; id: string }>;
  skipped: Array<{ title: string; id: string }>;
}

export async function seedPocRequirements(
  admin: PocStoryAdmin,
  options: { dryRun: boolean; owner: string },
): Promise<PocSeedResult> {
  const mapping = buildFieldMapping(await admin.listCustomFields());
  const existing = new Map<string, string>();
  for (const definition of POC_REQUIREMENTS) {
    const story = await admin.findStoryByExactTitle(definition.title);
    if (story) existing.set(definition.title, story.id);
  }

  const result: PocSeedResult = { planned: [], created: [], skipped: [] };
  for (const definition of POC_REQUIREMENTS) {
    const existingId = existing.get(definition.title);
    if (existingId) {
      result.skipped.push({ title: definition.title, id: existingId });
      continue;
    }

    result.planned.push(definition.title);
    if (options.dryRun) continue;
    const created = await admin.createStory({
      name: definition.title,
      owner: options.owner,
      fields: {
        [mapping.sourceType]: definition.sourceType,
        [mapping.evidenceLinks]: definition.evidenceLinks,
        [mapping.targetUsers]: definition.targetUsers,
        [mapping.scenario]: definition.scenario,
        [mapping.problem]: definition.problem,
        [mapping.goal]: definition.goal,
        [mapping.successMetrics]: definition.successMetrics,
        [mapping.scope]: definition.scope,
        [mapping.outOfScope]: definition.outOfScope,
        [mapping.productOwner]: options.owner,
        [mapping.developmentOwner]: options.owner,
        [mapping.testOwner]: options.owner,
        [mapping.blockerQuestions]: definition.blockerQuestions,
      },
    });
    result.created.push({ title: definition.title, id: created.id });
  }

  return result;
}
