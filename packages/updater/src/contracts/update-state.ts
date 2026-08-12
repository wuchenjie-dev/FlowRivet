import { z } from "zod";

const semver = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);

export const currentVersionSchema = z.object({
  schemaVersion: z.literal(1),
  activeVersion: semver,
  previousVersion: semver.optional(),
  activatedAt: z.iso.datetime(),
}).strict();

export type CurrentVersion = z.infer<typeof currentVersionSchema>;

export const updateStateSchema = z.object({
  schemaVersion: z.literal(1),
  lastSuccessfulVersion: semver.optional(),
  failedVersions: z.record(semver, z.object({
    failedAt: z.iso.datetime(),
    cooldownUntil: z.iso.datetime(),
    errorCode: z.string().regex(/^[a-z0-9_]+$/u),
  }).strict()),
}).strict();

export type UpdateState = z.infer<typeof updateStateSchema>;
