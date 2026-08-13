import { describe, expect, it } from "vitest";

import {
  encodeFieldValue,
  equalFieldValue,
  normalizeFieldValue,
} from "../src/writeback/field-value-codec.js";
import {
  MAX_EPOCH_MILLISECONDS,
  supportedFieldValueSchema,
  type SupportedFieldValue,
} from "../src/contracts/writeback.js";

describe("field value codec", () => {
  it.each([
    ["text", null, { type: "text", value: null }],
    ["text", "", { type: "text", value: null }],
    ["text", { text: "result" }, { type: "text", value: "result" }],
    ["link", "https://example.com/result", { type: "link", value: "https://example.com/result" }],
    ["link", "", { type: "link", value: null }],
    ["number", "0012.500", { type: "number", value: "12.5" }],
    ["number", 12.5, { type: "number", value: "12.5" }],
    ["number", "", { type: "number", value: null }],
    ["boolean", true, { type: "boolean", value: true }],
    ["boolean", "false", { type: "boolean", value: false }],
    ["boolean", "", { type: "boolean", value: null }],
    ["select", { option_id: "option-1" }, { type: "select", optionId: "option-1" }],
    ["select", null, { type: "select", optionId: null }],
    ["multi-select", [
      { optionId: "b" }, { option_id: "a" }, "b", "",
    ], { type: "multi-select", optionIds: ["a", "b"] }],
    ["date", 1_786_579_200_000, { type: "date", epochMilliseconds: "1786579200000" }],
    ["date", "1786579200000", { type: "date", epochMilliseconds: "1786579200000" }],
    ["date", "", { type: "date", epochMilliseconds: null }],
    ["user", { user_key: "user-1" }, { type: "user", userKey: "user-1" }],
    ["user", null, { type: "user", userKey: null }],
    ["multi-user", [
      { userKey: "user-2" }, { user_key: "user-1" }, "user-2", "",
    ], { type: "multi-user", userKeys: ["user-1", "user-2"] }],
  ] as const)("normalizes %s values", (type, raw, expected) => {
    expect(normalizeFieldValue(type, raw)).toEqual(expected);
  });

  it("compares normalized number and unordered multi-values", () => {
    expect(equalFieldValue(
      normalizeFieldValue("number", "0012.500"),
      normalizeFieldValue("number", 12.5),
    )).toBe(true);
    expect(equalFieldValue(
      normalizeFieldValue("multi-select", ["b", "a", "a"]),
      normalizeFieldValue("multi-select", ["a", "b"]),
    )).toBe(true);
    expect(equalFieldValue(
      normalizeFieldValue("user", "user-1"),
      normalizeFieldValue("user", "user-2"),
    )).toBe(false);
  });

  it("keeps normalized output inside the supported field value contract", () => {
    const outputs = [
      normalizeFieldValue("number", Number.MAX_SAFE_INTEGER),
      normalizeFieldValue("date", String(MAX_EPOCH_MILLISECONDS)),
      normalizeFieldValue("multi-select", ["b", "a", "a"]),
    ];
    for (const output of outputs) {
      expect(supportedFieldValueSchema.parse(output)).toEqual(output);
    }
  });

  it.each([
    ["date", "9007199254740993"],
    ["date", String(MAX_EPOCH_MILLISECONDS + 1)],
    ["date", "9".repeat(200)],
    ["number", "1000000000000000000000"],
    ["number", 1e21],
    ["multi-select", Array.from({ length: 101 }, (_, index) => `option-${index}`)],
    ["multi-user", Array.from({ length: 101 }, (_, index) => `user-${index}`)],
  ])("rejects non-canonical or out-of-contract %s input", (type, raw) => {
    expect(() => normalizeFieldValue(type, raw)).toThrowError(expect.objectContaining({
      message: "field_value_invalid",
      code: "field_value_invalid",
    }));
  });

  it.each([
    { type: "text", value: "result" },
    { type: "text", value: null },
    { type: "link", value: "https://example.com/result" },
    { type: "number", value: "12.5" },
    { type: "boolean", value: false },
    { type: "select", optionId: "option-1" },
    { type: "multi-select", optionIds: ["a", "b"] },
    { type: "date", epochMilliseconds: "1786579200000" },
    { type: "user", userKey: "user-1" },
    { type: "multi-user", userKeys: ["user-1", "user-2"] },
  ] satisfies SupportedFieldValue[])("round-trips $type values", (value) => {
    expect(normalizeFieldValue(value.type, encodeFieldValue(value))).toEqual(value);
  });

  it("encodes provider field payloads without a generic JSON fallback", () => {
    expect(encodeFieldValue({ type: "select", optionId: "option-1" }))
      .toEqual({ option_id: "option-1" });
    expect(encodeFieldValue({ type: "multi-select", optionIds: ["a", "b"] }))
      .toEqual([{ option_id: "a" }, { option_id: "b" }]);
    expect(encodeFieldValue({ type: "user", userKey: "user-1" }))
      .toEqual({ user_key: "user-1" });
    expect(encodeFieldValue({ type: "multi-user", userKeys: ["user-1", "user-2"] }))
      .toEqual([{ user_key: "user-1" }, { user_key: "user-2" }]);
  });

  it("uses set semantics for schema-valid multi-values without mutating inputs", () => {
    const left = supportedFieldValueSchema.parse({
      type: "multi-select", optionIds: ["b", "a", "b"],
    });
    const right = supportedFieldValueSchema.parse({
      type: "multi-select", optionIds: ["a", "b"],
    });
    const users = supportedFieldValueSchema.parse({
      type: "multi-user", userKeys: ["user-2", "user-1", "user-2"],
    });
    const leftBefore = structuredClone(left);
    const usersBefore = structuredClone(users);

    expect(equalFieldValue(left, right)).toBe(true);
    expect(encodeFieldValue(left)).toEqual([{ option_id: "a" }, { option_id: "b" }]);
    expect(encodeFieldValue(users)).toEqual([
      { user_key: "user-1" }, { user_key: "user-2" },
    ]);
    expect(left).toEqual(leftBefore);
    expect(users).toEqual(usersBefore);
  });

  it.each([
    () => normalizeFieldValue("unknown", { arbitrary: true }),
    () => encodeFieldValue({ type: "unknown", value: { arbitrary: true } } as never),
  ])("rejects unsupported field types with a stable code", (operation) => {
    expect(operation).toThrowError(expect.objectContaining({
      message: "field_type_unsupported",
      code: "field_type_unsupported",
    }));
  });

  it("rejects invalid known values instead of stringifying them", () => {
    expect(() => normalizeFieldValue("text", { arbitrary: true })).toThrow("field_value_invalid");
    expect(() => normalizeFieldValue("number", "   ")).toThrow("field_value_invalid");
    expect(() => normalizeFieldValue("link", "http://example.com/result"))
      .toThrow("field_value_invalid");
  });
});
