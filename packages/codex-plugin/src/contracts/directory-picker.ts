import { z } from "zod";

export const directoryPurposeSchema = z.enum([
  "existing_repository",
  "clone_parent",
]);

export const directorySelectionInputSchema = z.object({
  purpose: directoryPurposeSchema,
  initialDirectory: z.string().min(1).optional(),
}).strict();

export const directorySelectionSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("selected"),
    absolutePath: z.string().min(1),
  }).strict(),
  z.object({ outcome: z.literal("cancelled") }).strict(),
]);
