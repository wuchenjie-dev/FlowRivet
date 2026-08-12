import { z } from "zod";

export const glabProjectSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  name: z.string().min(1),
  path_with_namespace: z.string().min(1),
  default_branch: z.string().min(1),
  http_url_to_repo: z.url(),
}).passthrough();

export const glabProjectListSchema = z.array(glabProjectSchema);

export type GlabProject = z.infer<typeof glabProjectSchema>;
