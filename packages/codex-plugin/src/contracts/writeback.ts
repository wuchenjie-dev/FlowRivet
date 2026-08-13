import { z } from "zod";

export const MAX_EPOCH_MILLISECONDS = 8_640_000_000_000_000;
export const MAX_FIELD_TEXT_LENGTH = 16_000;
export const MAX_IDENTIFIER_LENGTH = 256;
export const MAX_LINK_LENGTH = 4_096;
export const MAX_SUBMISSION_STRING_BYTES = 256 * 1_024;
const MAX_CANONICAL_NUMBER_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const decimalInputPattern = /^-?(?:\d+\.?\d*|\.\d+)$/u;
const canonicalDecimalPattern = /^(?:0|-?[1-9]\d*)(?:\.\d+)?$/u;
export const serverWritebackMarkerPattern = /FLOWRIVET_WRITE_PROBE|FlowRivet writeback marker|flowrivet:(?:execution|writeback)/iu;

export interface ClientStringInspection {
  hasServerWritebackMarker: boolean;
  hasInvalidPercentEncoding: boolean;
}

export function inspectClientString(value: string): ClientStringInspection {
  let candidate = value;
  let hasInvalidPercentEncoding = false;
  for (let layer = 0; layer <= 3; layer += 1) {
    if (serverWritebackMarkerPattern.test(candidate)) {
      return { hasServerWritebackMarker: true, hasInvalidPercentEncoding };
    }
    if (layer === 3 || !candidate.includes("%")) break;
    const decoded = decodePercentLayer(candidate);
    candidate = decoded.value;
    hasInvalidPercentEncoding ||= decoded.invalid;
  }
  return { hasServerWritebackMarker: false, hasInvalidPercentEncoding };
}

export function containsServerWritebackMarker(value: string): boolean {
  return inspectClientString(value).hasServerWritebackMarker;
}

function decodePercentLayer(value: string): { value: string; invalid: boolean } {
  let invalid = /%(?![0-9a-f]{2})/iu.test(value);
  const decoded = value.replace(/(?:%[0-9a-f]{2})+/giu, (run) => {
    const bytes = Uint8Array.from(run.match(/[0-9a-f]{2}/giu) ?? [], (byte) =>
      Number.parseInt(byte, 16));
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      invalid = true;
    }
    return new TextDecoder("utf-8").decode(bytes);
  });
  return { value: decoded, invalid };
}

export function canonicalizeDecimal(value: string): string | undefined {
  if (value.length > 100 || !decimalInputPattern.test(value)) return undefined;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [rawInteger = "", rawFraction = ""] = unsigned.split(".");
  const integer = rawInteger.replace(/^0+(?=\d)/u, "") || "0";
  const fraction = rawFraction.replace(/0+$/u, "");
  if (BigInt(integer) > MAX_CANONICAL_NUMBER_INTEGER
    || (BigInt(integer) === MAX_CANONICAL_NUMBER_INTEGER && /[1-9]/u.test(fraction))) {
    return undefined;
  }
  const magnitude = fraction ? `${integer}.${fraction}` : integer;
  return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

export function isCanonicalDecimal(value: string): boolean {
  return canonicalDecimalPattern.test(value) && canonicalizeDecimal(value) === value;
}

export function isCanonicalEpochMilliseconds(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(value)
    && value.length <= String(MAX_EPOCH_MILLISECONDS).length
    && BigInt(value) <= BigInt(MAX_EPOCH_MILLISECONDS);
}

const httpsUrlSchema = z.url().max(MAX_LINK_LENGTH)
  .refine((value) => new URL(value).protocol === "https:");

const nullableIdentifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH).nullable();

const textFieldValueSchema = z.object({
  type: z.literal("text"),
  value: z.string().min(1).max(MAX_FIELD_TEXT_LENGTH).nullable(),
}).strict();

const linkFieldValueSchema = z.object({
  type: z.literal("link"),
  value: httpsUrlSchema.nullable(),
}).strict();

const numberFieldValueSchema = z.object({
  type: z.literal("number"),
  value: z.string().refine(isCanonicalDecimal, "field_value_invalid").nullable(),
}).strict();

const booleanFieldValueSchema = z.object({
  type: z.literal("boolean"),
  value: z.boolean().nullable(),
}).strict();

const selectFieldValueSchema = z.object({
  type: z.literal("select"),
  optionId: nullableIdentifierSchema,
}).strict();

const multiSelectFieldValueSchema = z.object({
  type: z.literal("multi-select"),
  optionIds: z.array(z.string().min(1).max(MAX_IDENTIFIER_LENGTH)).max(100),
}).strict();

const dateFieldValueSchema = z.object({
  type: z.literal("date"),
  epochMilliseconds: z.string()
    .refine(isCanonicalEpochMilliseconds, "field_value_invalid").nullable(),
}).strict();

const userFieldValueSchema = z.object({
  type: z.literal("user"),
  userKey: nullableIdentifierSchema,
}).strict();

const multiUserFieldValueSchema = z.object({
  type: z.literal("multi-user"),
  userKeys: z.array(z.string().min(1).max(MAX_IDENTIFIER_LENGTH)).max(100),
}).strict();

export const supportedFieldValueSchema = z.discriminatedUnion("type", [
  textFieldValueSchema,
  linkFieldValueSchema,
  numberFieldValueSchema,
  booleanFieldValueSchema,
  selectFieldValueSchema,
  multiSelectFieldValueSchema,
  dateFieldValueSchema,
  userFieldValueSchema,
  multiUserFieldValueSchema,
]);

export type SupportedFieldValue = z.infer<typeof supportedFieldValueSchema>;

export const fieldProposalSchema = z.object({
  proposalId: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
  fieldKey: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
  expectedCurrentValue: supportedFieldValueSchema,
  proposedValue: supportedFieldValueSchema,
  reason: z.string().min(1).max(2_000),
}).strict().superRefine((proposal, context) => {
  if (proposal.expectedCurrentValue.type !== proposal.proposedValue.type) {
    context.addIssue({
      code: "custom",
      message: "field_value_type_mismatch",
      path: ["proposedValue", "type"],
    });
  }
});

export type FieldProposal = z.infer<typeof fieldProposalSchema>;
