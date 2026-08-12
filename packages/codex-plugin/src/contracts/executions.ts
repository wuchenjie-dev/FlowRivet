import { z } from "zod";

export const executionKinds = [
  "requirement_breakdown", "requirement_analysis", "development",
] as const;
export const executionStates = [
  "prepared", "awaiting_repository", "ready", "running",
  "awaiting_confirmation", "writeback_pending", "completed", "failed",
] as const;

export const executionArtifactSchema = z.object({
  artifactId: z.string().min(1),
  type: z.string().min(1),
  revision: z.number().int().positive(),
  uri: z.string().min(1).optional(),
  summary: z.string().min(1).max(2_000).optional(),
  createdAt: z.iso.datetime(),
}).strict();

export const executionRepositorySchema = z.object({
  host: z.literal("gitlab-aiabu.ruijie.com.cn"),
  projectId: z.string().min(1),
  projectPath: z.string().min(1),
  localPath: z.string().min(1),
  branch: z.string().min(1).optional(),
  mergeRequestIid: z.number().int().positive().optional(),
  mergeRequestUrl: z.url().optional(),
  pipelineId: z.string().min(1).optional(),
}).strict();

export const executionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  executionId: z.string().min(1),
  providerId: z.literal("feishu-project"),
  accountKey: z.string().min(1),
  workItemKey: z.string().min(1),
  workItemUpdatedAt: z.iso.datetime().optional(),
  taskLaunchMode: z.enum(["direct", "handoff"]),
  codexTaskId: z.string().min(1).optional(),
  codexHandoffId: z.string().min(1).optional(),
  executionKind: z.enum(executionKinds),
  state: z.enum(executionStates),
  gitlab: executionRepositorySchema.optional(),
  artifacts: z.array(executionArtifactSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
export type ExecutionRepository = z.infer<typeof executionRepositorySchema>;
export type ExecutionKind = z.infer<typeof executionRecordSchema>["executionKind"];
export type ExecutionState = z.infer<typeof executionRecordSchema>["state"];
