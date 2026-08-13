import { z } from "zod";
import {
  fieldProposalSchema,
  inspectClientString,
  MAX_IDENTIFIER_LENGTH,
  MAX_LINK_LENGTH,
  MAX_SUBMISSION_STRING_BYTES,
} from "./writeback.js";

export const executionKinds = [
  "pending_classification", "requirement_breakdown", "requirement_analysis", "development",
] as const;
export const executionLabels = [
  "requirement_breakdown", "requirement_analysis", "development",
] as const;
export const executionWorkModes = ["pending", "non_code", "code"] as const;
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
  content: z.string().min(1).max(8_000).optional(),
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

const executionRecordFields = {
  executionId: z.string().min(1),
  providerId: z.literal("feishu-project"),
  accountKey: z.string().min(1),
  workItemKey: z.string().min(1),
  workItemUpdatedAt: z.iso.datetime().optional(),
  taskLaunchMode: z.enum(["direct", "handoff"]),
  codexTaskId: z.string().min(1).optional(),
  codexHandoffId: z.string().min(1).optional(),
  state: z.enum(executionStates),
  gitlab: executionRepositorySchema.optional(),
  artifacts: z.array(executionArtifactSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
} as const;

export const persistedExecutionRecordV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...executionRecordFields,
  executionKind: z.enum(executionKinds),
}).strict();

export const executionRecordSchema = z.object({
  schemaVersion: z.literal(2),
  ...executionRecordFields,
  attempt: z.number().int().positive(),
  handoffDispatchedAt: z.iso.datetime().optional(),
  workMode: z.enum(executionWorkModes),
  executionKind: z.enum(executionKinds).optional(),
}).strict();

export const workExecutionHandoffSchema = z.object({
  execution: executionRecordSchema,
  handoff: z.object({
    handoffId: z.string().min(1),
    prompt: z.string().min(1).max(12_000),
  }).strict(),
}).strict();

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
export type ExecutionArtifact = z.infer<typeof executionArtifactSchema>;
export type ExecutionRepository = z.infer<typeof executionRepositorySchema>;
export type ExecutionKind = z.infer<typeof executionRecordSchema>["executionKind"];
export type ExecutionWorkMode = z.infer<typeof executionRecordSchema>["workMode"];
export type ExecutionState = z.infer<typeof executionRecordSchema>["state"];
export type WorkExecutionHandoff = z.infer<typeof workExecutionHandoffSchema>;

const clientTextSchema = (maximum: number) => z.string().min(1).max(maximum);

export const submitExecutionResultSchema = z.object({
  executionId: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
  revision: z.number().int().positive(),
  summary: clientTextSchema(2_000),
  resultMarkdown: clientTextSchema(8_000),
  verification: z.object({
    status: z.enum(["passed", "failed", "not_applicable"]),
    summary: clientTextSchema(2_000),
  }).strict(),
  artifacts: z.array(z.object({
    type: z.enum(["document", "branch", "merge_request", "pipeline"]),
    title: z.string().min(1).max(500),
    url: z.url().max(MAX_LINK_LENGTH)
      .refine((value) => new URL(value).protocol === "https:").optional(),
  }).strict()).max(100),
  fieldProposals: z.array(fieldProposalSchema).max(100),
}).strict().superRefine((submission, context) => {
  const proposalIds = new Set<string>();
  for (const [index, proposal] of submission.fieldProposals.entries()) {
    if (proposalIds.has(proposal.proposalId)) {
      context.addIssue({
        code: "custom",
        message: "proposal_id_duplicate",
        path: ["fieldProposals", index, "proposalId"],
      });
    }
    proposalIds.add(proposal.proposalId);
  }
  for (const issue of inspectSubmissionStrings(submission)) {
    context.addIssue({
      code: "custom",
      message: issue.message,
      path: issue.path,
    });
  }
  if (totalStringBytes(submission) > MAX_SUBMISSION_STRING_BYTES) {
    context.addIssue({
      code: "custom",
      message: "submission_string_bytes_exceeded",
      path: [],
    });
  }
});

export type SubmitExecutionResult = z.infer<typeof submitExecutionResultSchema>;

function inspectSubmissionStrings(
  value: unknown,
  path: PropertyKey[] = [],
): Array<{ message: "writeback_marker_forbidden" | "client_string_encoding_invalid"; path: PropertyKey[] }> {
  if (typeof value === "string") {
    const inspection = inspectClientString(value);
    if (inspection.hasServerWritebackMarker) {
      return [{ message: "writeback_marker_forbidden", path }];
    }
    return inspection.hasInvalidPercentEncoding
      ? [{ message: "client_string_encoding_invalid", path }]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => inspectSubmissionStrings(child, [...path, index]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      inspectSubmissionStrings(child, [...path, key]));
  }
  return [];
}

function totalStringBytes(value: unknown): number {
  if (typeof value === "string") return new TextEncoder().encode(value).length;
  if (Array.isArray(value)) {
    return value.reduce((total, child) => total + totalStringBytes(child), 0);
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce((total, child) => total + totalStringBytes(child), 0);
  }
  return 0;
}

export const confirmationChallengeSchema = z.object({
  challengeId: z.string().min(1), operationId: z.string().min(1),
  action: z.enum(["merge_mr", "retry_pipeline", "close_work_item"]),
  actorKey: z.string().min(1), targetVersion: z.string().min(1),
  summary: z.object({ title: z.string().min(1), details: z.array(z.string().min(1)).max(20) }).strict(),
  expiresAt: z.iso.datetime(),
}).strict();
export type ConfirmationChallenge = z.infer<typeof confirmationChallengeSchema>;
export const guardedActionAuthorizationSchema = z.object({
  authorized: z.literal(true),
  operationId: z.string().min(1),
  action: z.enum(["merge_mr", "retry_pipeline", "close_work_item"]),
  targetVersion: z.string().min(1),
}).strict();

export const executionWritebackResultSchema = z.object({
  execution: executionRecordSchema,
  writeback: z.object({
    state: z.enum(["written", "local_only"]),
    errorCode: z.literal("feishu_write_capability_unsupported").optional(),
    content: z.string().min(1).max(8_000),
  }).strict(),
}).strict();
