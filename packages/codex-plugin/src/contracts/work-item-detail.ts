import { z } from "zod";

import { workItemKinds } from "./taskboard.js";

export const providerWorkItemTypes = ["story", "task", "bug"] as const;

export const workItemDetailRefSchema = z.object({
  providerId: z.string().min(1),
  projectExternalId: z.string().min(1),
  providerItemType: z.enum(providerWorkItemTypes),
  externalId: z.string().min(1),
}).strict();

export const workItemDetailSchema = workItemDetailRefSchema.extend({
  key: z.string().min(1),
  projectName: z.string().min(1),
  kind: z.enum(workItemKinds),
  title: z.string().min(1),
  providerStatus: z.string().min(1),
  priority: z.string().optional(),
  assignees: z.array(z.string().min(1)),
  creator: z.string().optional(),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
  dueAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  sanitizedDescriptionHtml: z.string().optional(),
  descriptionTruncated: z.boolean(),
  externalUrl: z.url().refine((url) => new URL(url).protocol === "https:", {
    message: "externalUrl must use HTTPS",
  }),
}).strict();

export type ProviderWorkItemType = (typeof providerWorkItemTypes)[number];
export type WorkItemDetailRef = z.infer<typeof workItemDetailRefSchema>;
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>;
