import { z } from "zod";

export const canonicalStages = [
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const;

export const workItemKinds = ["story", "task", "bug"] as const;

export const connectionStates = [
  "disconnected",
  "connecting",
  "connected",
  "expired",
] as const;

export const workItemSchema = z.object({
  key: z.string(),
  tapdId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  kind: z.enum(workItemKinds),
  title: z.string(),
  stage: z.enum(canonicalStages),
  priority: z.string().optional(),
  dueAt: z.string().optional(),
});

export const taskboardSnapshotSchema = z.object({
  connection: z.object({
    tapd: z.enum(connectionStates),
    gitlab: z.literal("not_configured"),
    userName: z.string().optional(),
    companyName: z.string().optional(),
  }),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  stages: z.tuple([
    z.literal("todo"),
    z.literal("in_progress"),
    z.literal("in_review"),
    z.literal("done"),
  ]),
  items: z.array(workItemSchema),
  lastSyncedAt: z.string(),
});

export type CanonicalStage = (typeof canonicalStages)[number];
export type WorkItemKind = (typeof workItemKinds)[number];
export type WorkItem = z.infer<typeof workItemSchema>;
export type TaskboardSnapshot = z.infer<typeof taskboardSnapshotSchema>;
