import { z } from "zod";

export const SOURCE_TYPES = [
  "用户VOC",
  "产品规划",
  "体验优化",
  "技术",
  "质量",
  "安全合规",
  "战略",
  "探索",
] as const;

const requirementSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().regex(/^\d+$/),
  title: z.string().min(1),
  status: z.string().min(1),
  sourceType: z.enum(SOURCE_TYPES),
  evidenceLinks: z.array(z.url()),
  targetUsers: z.string(),
  scenario: z.string(),
  problem: z.string(),
  goal: z.string(),
  successMetrics: z.string(),
  scope: z.string(),
  outOfScope: z.string(),
  owners: z.object({
    product: z.string().min(1),
    development: z.string().min(1),
    test: z.string().min(1),
  }),
  blockerQuestions: z.array(z.string().min(1)),
});

export type Requirement = z.infer<typeof requirementSchema>;
export type SourceType = Requirement["sourceType"];

export function parseRequirement(input: unknown): Requirement {
  return requirementSchema.parse(input);
}
