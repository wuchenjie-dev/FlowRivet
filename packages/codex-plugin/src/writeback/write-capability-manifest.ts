import { z } from "zod";

const capabilitySchema = z.object({
  enabled: z.boolean(),
  write: z.boolean().optional(),
  read: z.boolean().optional(),
  repeat: z.boolean().optional(),
  restore: z.boolean().optional(),
}).strict();

const commentCapabilitySchema = z.object({
  enabled: z.boolean(),
  list: z.boolean(),
  create: z.boolean(),
  read: z.boolean(),
  update: z.boolean(),
  repeat: z.boolean(),
  cleanup: z.literal(false),
}).strict();

export const supportedWriteFieldTypes = [
  "text", "link", "number", "boolean", "select", "multi-select", "date",
] as const;
const supportedWriteFieldTypeSchema = z.enum(supportedWriteFieldTypes);

export const writeCapabilityManifestSchema = z.object({
  cliVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  probeVersion: z.string().min(1),
  comment: commentCapabilitySchema,
  fieldTypes: z.partialRecord(supportedWriteFieldTypeSchema, capabilitySchema),
  state: capabilitySchema,
  node: capabilitySchema,
  role: capabilitySchema,
  verifiedAt: z.iso.datetime().nullable(),
}).strict();

export type WriteCapabilityManifest = z.infer<typeof writeCapabilityManifestSchema>;

export const disabledWriteCapabilities: WriteCapabilityManifest = Object.freeze({
  cliVersion: "0.0.0",
  probeVersion: "0",
  comment: Object.freeze({
    enabled: false, list: false, create: false, read: false, update: false, repeat: false, cleanup: false,
  }),
  fieldTypes: Object.freeze({}),
  state: Object.freeze({ enabled: false }),
  node: Object.freeze({ enabled: false }),
  role: Object.freeze({ enabled: false }),
  verifiedAt: null,
});

export function loadWriteCapabilityManifest(
  raw: unknown,
  expected: { cliVersion: string; probeVersion: string },
): WriteCapabilityManifest {
  const parsed = writeCapabilityManifestSchema.safeParse(raw);
  if (!parsed.success
    || parsed.data.cliVersion !== expected.cliVersion
    || parsed.data.probeVersion !== expected.probeVersion
    || parsed.data.verifiedAt === null) {
    return disabledWriteCapabilities;
  }
  return {
    ...parsed.data,
    comment: normalizeCommentCapability(parsed.data.comment),
    fieldTypes: Object.fromEntries(Object.entries(parsed.data.fieldTypes)
      .map(([type, capability]) => [type, normalizeCapability(capability)])),
    state: normalizeCapability(parsed.data.state),
    node: normalizeCapability(parsed.data.node),
    role: normalizeCapability(parsed.data.role),
  };
}

function normalizeCommentCapability(capability: z.infer<typeof commentCapabilitySchema>) {
  const proven = capability.list && capability.create && capability.read && capability.update && capability.repeat;
  return { ...capability, enabled: capability.enabled && proven };
}

function normalizeCapability(capability: z.infer<typeof capabilitySchema>) {
  const proven = capability.write === true
    && capability.read === true
    && capability.repeat === true
    && capability.restore === true;
  return { ...capability, enabled: capability.enabled && proven };
}
