import { z } from "zod";

const safeName = z.string().min(1).max(200).regex(/^[0-9A-Za-z._-]+$/u);

export const updateConfigSchema = z.object({
  schemaVersion: z.literal(1),
  gitlabBaseUrl: z.url().refine((value) => new URL(value).protocol === "https:"),
  projectId: z.string().min(1).max(300),
  runtimePackageName: safeName,
  channelPackageName: safeName,
  channelVersion: safeName,
  credentialReference: z.string().min(1).max(500),
  redirectHostAllowlist: z.array(z.string().min(1).max(253)).max(20),
}).strict();

export type UpdateConfig = z.infer<typeof updateConfigSchema>;
