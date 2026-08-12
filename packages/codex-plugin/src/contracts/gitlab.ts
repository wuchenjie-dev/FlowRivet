import { z } from "zod";

export const gitLabConnectionStates = [
  "checking",
  "cli_missing",
  "cli_unsupported",
  "disconnected",
  "connected",
  "unavailable",
] as const;

export const gitLabConnectionSchema = z.object({
  host: z.string().min(1),
  state: z.enum(gitLabConnectionStates),
  accountDisplayName: z.string().min(1).optional(),
  cliVersion: z.string().min(1).optional(),
}).strict();

const credentialFreeHttpsUrl = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    context.addIssue({
      code: "custom",
      message: "GitLab repository URL must be credential-free HTTPS",
    });
  }
});

export const gitLabProjectSchema = z.object({
  host: z.string().min(1),
  projectId: z.string().min(1),
  pathWithNamespace: z.string().min(1),
  displayName: z.string().min(1),
  defaultBranch: z.string().min(1),
  httpUrl: credentialFreeHttpsUrl,
}).strict();

export const gitLabProjectPageSchema = z.object({
  page: z.number().int().positive(),
  hasMore: z.boolean(),
  projects: z.array(gitLabProjectSchema),
}).strict();

export const gitLabLoginResultSchema = z.object({
  state: z.enum(["waiting", "connected"]),
}).strict();

export type GitLabConnection = z.infer<typeof gitLabConnectionSchema>;
export type GitLabProject = z.infer<typeof gitLabProjectSchema>;
export type GitLabProjectPage = z.infer<typeof gitLabProjectPageSchema>;
export type GitLabLoginResult = z.infer<typeof gitLabLoginResultSchema>;
