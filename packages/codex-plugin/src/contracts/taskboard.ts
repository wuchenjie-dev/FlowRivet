import { z } from "zod";

import { projectCatalogSchema, projectRefSchema } from "./projects.js";

export const canonicalStages = [
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const;

export const workItemKinds = ["requirement", "task", "defect", "other"] as const;

export const connectionStates = [
  "disconnected",
  "connecting",
  "connected",
  "expired",
] as const;

export const workItemSchema = z.object({
  key: z.string(),
  providerId: z.string(),
  externalId: z.string(),
  projectExternalId: z.string(),
  projectName: z.string(),
  kind: z.enum(workItemKinds),
  providerItemType: z.string(),
  title: z.string(),
  stage: z.enum(canonicalStages),
  providerStatus: z.string(),
  priority: z.string().optional(),
  dueAt: z.string().optional(),
  completedAt: z.string().optional(),
  externalUrl: z.string(),
});

export const taskboardSnapshotSchema = z.object({
  connection: z.object({
    tapd: z.enum(connectionStates),
    gitlab: z.literal("not_configured"),
    userName: z.string().optional(),
    companyName: z.string().optional(),
  }),
  projectCatalog: projectCatalogSchema,
  projects: z.array(projectRefSchema.extend({
    count: z.number().int().nonnegative(),
  })),
  stages: z.tuple([
    z.literal("todo"),
    z.literal("in_progress"),
    z.literal("in_review"),
    z.literal("done"),
  ]),
  items: z.array(workItemSchema),
  readOnly: z.literal(true),
  syncSummary: z.object({
    successfulProjects: z.number().int().nonnegative(),
    failedProjects: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative(),
  }),
  syncErrorCode: z.literal("work_item_sync_failed").optional(),
  lastSyncedAt: z.string(),
});

export type CanonicalStage = (typeof canonicalStages)[number];
export type WorkItemKind = (typeof workItemKinds)[number];
export type WorkItem = z.infer<typeof workItemSchema>;
export type TaskboardSnapshot = z.infer<typeof taskboardSnapshotSchema>;
