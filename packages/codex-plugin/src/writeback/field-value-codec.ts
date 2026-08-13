import {
  canonicalizeDecimal,
  isCanonicalEpochMilliseconds,
  supportedFieldValueSchema,
  type SupportedFieldValue,
} from "../contracts/writeback.js";

export type SupportedFieldType = SupportedFieldValue["type"];

export class FieldValueCodecError extends Error {
  constructor(readonly code: "field_type_unsupported" | "field_value_invalid") {
    super(code);
    this.name = "FieldValueCodecError";
  }
}

export function normalizeFieldValue(type: SupportedFieldType | string, raw: unknown): SupportedFieldValue {
  let normalized: SupportedFieldValue;
  switch (type) {
    case "text": normalized = { type, value: normalizeText(raw) }; break;
    case "link": normalized = { type, value: normalizeLink(raw) }; break;
    case "number": normalized = { type, value: normalizeNumber(raw) }; break;
    case "boolean": normalized = { type, value: normalizeBoolean(raw) }; break;
    case "select": normalized = { type, optionId: normalizeIdentifier(raw, "option") }; break;
    case "multi-select": normalized = { type, optionIds: normalizeIdentifiers(raw, "option") }; break;
    case "date": normalized = { type, epochMilliseconds: normalizeDate(raw) }; break;
    case "user": normalized = { type, userKey: normalizeIdentifier(raw, "user") }; break;
    case "multi-user": normalized = { type, userKeys: normalizeIdentifiers(raw, "user") }; break;
    default: throw new FieldValueCodecError("field_type_unsupported");
  }
  const parsed = supportedFieldValueSchema.safeParse(normalized);
  if (!parsed.success) throw new FieldValueCodecError("field_value_invalid");
  return parsed.data;
}

export function equalFieldValue(left: SupportedFieldValue, right: SupportedFieldValue): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "text":
    case "link":
    case "number":
    case "boolean": return left.value === (right as typeof left).value;
    case "select": return left.optionId === (right as typeof left).optionId;
    case "multi-select": return equalStringArrays(
      canonicalStringSet(left.optionIds), canonicalStringSet((right as typeof left).optionIds),
    );
    case "date": return left.epochMilliseconds === (right as typeof left).epochMilliseconds;
    case "user": return left.userKey === (right as typeof left).userKey;
    case "multi-user": return equalStringArrays(
      canonicalStringSet(left.userKeys), canonicalStringSet((right as typeof left).userKeys),
    );
    default: return assertNever(left);
  }
}

export function encodeFieldValue(value: SupportedFieldValue): unknown {
  switch (value.type) {
    case "text":
    case "link":
    case "number":
    case "boolean": return value.value;
    case "select": return value.optionId === null ? null : { option_id: value.optionId };
    case "multi-select": return canonicalStringSet(value.optionIds)
      .map((optionId) => ({ option_id: optionId }));
    case "date": return value.epochMilliseconds;
    case "user": return value.userKey === null ? null : { user_key: value.userKey };
    case "multi-user": return canonicalStringSet(value.userKeys)
      .map((userKey) => ({ user_key: userKey }));
    default: throw new FieldValueCodecError("field_type_unsupported");
  }
}

function normalizeText(raw: unknown): string | null {
  if (raw === null || raw === "") return null;
  if (typeof raw === "string") return raw;
  if (isRecord(raw) && typeof raw.text === "string") return raw.text || null;
  throw new FieldValueCodecError("field_value_invalid");
}

function normalizeLink(raw: unknown): string | null {
  const value = normalizeText(raw);
  if (value === null) return null;
  try {
    if (new URL(value).protocol === "https:") return value;
  } catch {}
  throw new FieldValueCodecError("field_value_invalid");
}

function normalizeNumber(raw: unknown): string | null {
  if (raw === null || raw === "") return null;
  if (typeof raw === "string" && raw.trim() === "") {
    throw new FieldValueCodecError("field_value_invalid");
  }
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new FieldValueCodecError("field_value_invalid");
  }
  const canonical = canonicalizeDecimal(String(raw));
  if (canonical === undefined) throw new FieldValueCodecError("field_value_invalid");
  return canonical;
}

function normalizeBoolean(raw: unknown): boolean | null {
  if (raw === null || raw === "") return null;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new FieldValueCodecError("field_value_invalid");
}

function normalizeIdentifier(raw: unknown, kind: "option" | "user"): string | null {
  if (raw === null || raw === "") return null;
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) throw new FieldValueCodecError("field_value_invalid");
  const candidates = kind === "option"
    ? [raw.optionId, raw.option_id]
    : [raw.userKey, raw.user_key];
  const value = candidates.find((candidate): candidate is string => typeof candidate === "string");
  if (value) return value;
  throw new FieldValueCodecError("field_value_invalid");
}

function normalizeIdentifiers(raw: unknown, kind: "option" | "user"): string[] {
  if (raw === null || raw === "") return [];
  if (!Array.isArray(raw)) throw new FieldValueCodecError("field_value_invalid");
  const values = canonicalStringSet(raw
    .map((value) => normalizeIdentifier(value, kind))
    .filter((value): value is string => value !== null));
  if (values.length > 100) throw new FieldValueCodecError("field_value_invalid");
  return values;
}

function normalizeDate(raw: unknown): string | null {
  if (raw === null || raw === "") return null;
  const value = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof value === "string" && isCanonicalEpochMilliseconds(value)) return value;
  throw new FieldValueCodecError("field_value_invalid");
}

function canonicalStringSet(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function equalStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new FieldValueCodecError("field_type_unsupported");
}
