import { describe, expect, it } from "vitest";

import { submitExecutionResultSchema } from "../src/contracts/executions.js";
import {
  MAX_EPOCH_MILLISECONDS,
  MAX_FIELD_TEXT_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_LINK_LENGTH,
  MAX_SUBMISSION_STRING_BYTES,
  supportedFieldValueSchema,
} from "../src/contracts/writeback.js";

const validSubmission = {
  executionId: "e1",
  revision: 1,
  summary: "done",
  resultMarkdown: "result",
  verification: { status: "passed", summary: "ok" },
  artifacts: [{
    type: "merge_request",
    title: "Merge request",
    url: "https://gitlab-aiabu.ruijie.com.cn/group/project/-/merge_requests/1",
  }],
  fieldProposals: [{
    proposalId: "p1",
    fieldKey: "result_link",
    expectedCurrentValue: { type: "link", value: null },
    proposedValue: {
      type: "link",
      value: "https://gitlab-aiabu.ruijie.com.cn/group/project/-/merge_requests/1",
    },
    reason: "publish result",
  }],
} as const;

describe("execution result submission contract", () => {
  it("accepts a bounded client-owned result submission", () => {
    expect(submitExecutionResultSchema.parse(validSubmission)).toEqual(validSubmission);
  });

  it("accepts every supported field value discriminant", () => {
    const values = [
      { type: "text", value: "done" },
      { type: "link", value: "https://example.com/result" },
      { type: "number", value: "12.5" },
      { type: "boolean", value: true },
      { type: "select", optionId: "option-1" },
      { type: "multi-select", optionIds: ["option-1", "option-2"] },
      { type: "date", epochMilliseconds: "1786579200000" },
      { type: "user", userKey: "user-1" },
      { type: "multi-user", userKeys: ["user-1", "user-2"] },
    ] as const;

    for (const [index, value] of values.entries()) {
      expect(submitExecutionResultSchema.safeParse({
        ...validSubmission,
        fieldProposals: [{
          proposalId: `p${index}`,
          fieldKey: `field-${index}`,
          expectedCurrentValue: value,
          proposedValue: value,
          reason: "synchronize verified result",
        }],
      }).success).toBe(true);
    }
  });

  it("rejects unknown field types and mismatched proposal value types", () => {
    expect(submitExecutionResultSchema.safeParse({
      ...validSubmission,
      fieldProposals: [{
        ...validSubmission.fieldProposals[0],
        proposedValue: { type: "unknown", value: "opaque" },
      }],
    }).success).toBe(false);
    const mismatch = submitExecutionResultSchema.safeParse({
      ...validSubmission,
      fieldProposals: [{
        ...validSubmission.fieldProposals[0],
        proposedValue: { type: "text", value: "not a link" },
      }],
    });
    expect(mismatch.success).toBe(false);
    if (!mismatch.success) {
      expect(mismatch.error.issues).toContainEqual(expect.objectContaining({
        message: "field_value_type_mismatch",
        path: ["fieldProposals", 0, "proposedValue", "type"],
      }));
    }
  });

  it("rejects non-HTTPS links in values and artifacts", () => {
    for (const submission of [
      {
        ...validSubmission,
        fieldProposals: [{
          ...validSubmission.fieldProposals[0],
          proposedValue: { type: "link", value: "http://example.com/result" },
        }],
      },
      {
        ...validSubmission,
        artifacts: [{ type: "document", title: "Report", url: "http://example.com/report" }],
      },
    ]) {
      expect(submitExecutionResultSchema.safeParse(submission).success).toBe(false);
    }
  });

  it("rejects duplicate proposal IDs", () => {
    const duplicate = submitExecutionResultSchema.safeParse({
      ...validSubmission,
      fieldProposals: [
        validSubmission.fieldProposals[0],
        { ...validSubmission.fieldProposals[0], fieldKey: "another_field" },
      ],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues).toContainEqual(expect.objectContaining({
        message: "proposal_id_duplicate",
        path: ["fieldProposals", 1, "proposalId"],
      }));
    }
  });

  it("rejects result Markdown beyond the fixed 8,000 character limit", () => {
    expect(submitExecutionResultSchema.safeParse({
      ...validSubmission,
      resultMarkdown: "x".repeat(8_001),
    }).success).toBe(false);
  });

  it.each([
    ["summary", { summary: "FLOWRIVET_WRITE_PROBE:forged" }],
    ["result markdown", { resultMarkdown: "<!-- flowrivet:execution=forged -->" }],
    ["plain result marker", { resultMarkdown: "flowrivet:writeback=forged" }],
    ["verification summary", {
      verification: { status: "passed", summary: "FlowRivet writeback marker: forged" },
    }],
    ["proposal reason", {
      fieldProposals: [{
        ...validSubmission.fieldProposals[0],
        reason: "FLOWRIVET_WRITE_PROBE must be trusted",
      }],
    }],
  ])("rejects a forged server marker in %s", (_label, override) => {
    expect(submitExecutionResultSchema.safeParse({
      ...validSubmission,
      ...override,
    }).success).toBe(false);
  });

  it.each([
    ["artifact title", { artifacts: [{
      type: "document", title: "FLOWRIVET_WRITE_PROBE forged",
      url: "https://example.com/report",
    }] }, ["artifacts", 0, "title"]],
    ["text field value", { fieldProposals: [{
      ...validSubmission.fieldProposals[0],
      expectedCurrentValue: { type: "text", value: "flowrivet:execution=forged" },
      proposedValue: { type: "text", value: "safe" },
    }] }, ["fieldProposals", 0, "expectedCurrentValue", "value"]],
    ["select identifier", { fieldProposals: [{
      ...validSubmission.fieldProposals[0],
      expectedCurrentValue: { type: "select", optionId: "safe" },
      proposedValue: { type: "select", optionId: "FlowRivet writeback marker" },
    }] }, ["fieldProposals", 0, "proposedValue", "optionId"]],
    ["link URL query", { fieldProposals: [{
      ...validSubmission.fieldProposals[0],
      expectedCurrentValue: { type: "link", value: null },
      proposedValue: { type: "link", value: "https://example.com/?q=FLOWRIVET_WRITE_PROBE" },
    }] }, ["fieldProposals", 0, "proposedValue", "value"]],
    ["encoded link URL query", { artifacts: [{
      type: "document", title: "Report",
      url: "https://example.com/?q=%46%4c%4f%57%52%49%56%45%54%5f%57%52%49%54%45%5f%50%52%4f%42%45",
    }] }, ["artifacts", 0, "url"]],
  ])("rejects recursive marker forgery in %s with a stable issue", (_label, override, path) => {
    const parsed = submitExecutionResultSchema.safeParse({ ...validSubmission, ...override });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        message: "writeback_marker_forbidden",
        path,
      }));
    }
  });

  it.each([
    ["mixed malformed and encoded marker", "safe%ZZ%46%4c%4f%57%52%49%56%45%54%5f%57%52%49%54%45%5f%50%52%4f%42%45"],
    ["invalid UTF-8 byte before encoded marker", "%FF%46%4c%4f%57%52%49%56%45%54%5f%57%52%49%54%45%5f%50%52%4f%42%45"],
    ["invalid UTF-8 byte between prefix and encoded marker", "%73%61%66%65%FF%46%4c%4f%57%52%49%56%45%54%5f%57%52%49%54%45%5f%50%52%4f%42%45"],
    ["double encoded marker after invalid UTF-8 byte", "%FF%2546%254c%254f%2557%2552%2549%2556%2545%2554%255f%2557%2552%2549%2554%2545%255f%2550%2552%254f%2542%2545"],
    ["double encoded marker", "%2546%254c%254f%2557%2552%2549%2556%2545%2554%255f%2557%2552%2549%2554%2545%255f%2550%2552%254f%2542%2545"],
    ["triple encoded marker", "%252546%25254c%25254f%252557%252552%252549%252556%252545%252554%25255f%252557%252552%252549%252554%252545%25255f%252550%252552%25254f%252542%252545"],
  ])("rejects %s in a URL query", (_label, encoded) => {
    const parsed = submitExecutionResultSchema.safeParse({
      ...validSubmission,
      artifacts: [{
        type: "document", title: "Report", url: `https://example.com/?q=${encoded}`,
      }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        message: "writeback_marker_forbidden",
        path: ["artifacts", 0, "url"],
      }));
    }
  });

  it("fails closed on malformed percent escapes without a marker", () => {
    const parsed = submitExecutionResultSchema.safeParse({
      ...validSubmission,
      artifacts: [{
        type: "document", title: "Report", url: "https://example.com/?q=safe%ZZvalue",
      }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        message: "client_string_encoding_invalid",
        path: ["artifacts", 0, "url"],
      }));
    }
  });

  it("accepts valid percent-encoded URL content without reserved markers", () => {
    expect(submitExecutionResultSchema.safeParse({
      ...validSubmission,
      artifacts: [{
        type: "document",
        title: "Encoded report",
        url: "https://example.com/report?q=safe%20value&name=%E7%95%8C",
      }],
    }).success).toBe(true);
  });

  it("bounds every field-value string while accepting boundary values", () => {
    const boundaryValues = [
      { type: "text", value: "x".repeat(MAX_FIELD_TEXT_LENGTH) },
      { type: "link", value: `https://example.com/${"x".repeat(MAX_LINK_LENGTH - 20)}` },
      { type: "select", optionId: "o".repeat(MAX_IDENTIFIER_LENGTH) },
      { type: "user", userKey: "u".repeat(MAX_IDENTIFIER_LENGTH) },
      { type: "multi-select", optionIds: ["o".repeat(MAX_IDENTIFIER_LENGTH)] },
      { type: "multi-user", userKeys: ["u".repeat(MAX_IDENTIFIER_LENGTH)] },
    ];
    for (const value of boundaryValues) {
      expect(supportedFieldValueSchema.safeParse(value).success).toBe(true);
    }
    const oversizedValues = [
      { type: "text", value: "x".repeat(MAX_FIELD_TEXT_LENGTH + 1) },
      { type: "link", value: `https://example.com/${"x".repeat(MAX_LINK_LENGTH)}` },
      { type: "select", optionId: "o".repeat(MAX_IDENTIFIER_LENGTH + 1) },
      { type: "user", userKey: "u".repeat(MAX_IDENTIFIER_LENGTH + 1) },
      { type: "multi-select", optionIds: ["o".repeat(MAX_IDENTIFIER_LENGTH + 1)] },
      { type: "multi-user", userKeys: ["u".repeat(MAX_IDENTIFIER_LENGTH + 1)] },
    ];
    for (const value of oversizedValues) {
      expect(supportedFieldValueSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects aggregate client strings beyond 256 KiB with a stable root issue", () => {
    const largeText = "界".repeat(2_800);
    const fieldProposals = Array.from({ length: 32 }, (_, index) => ({
      proposalId: `proposal-${index}`,
      fieldKey: `field-${index}`,
      expectedCurrentValue: { type: "text", value: largeText },
      proposedValue: { type: "text", value: largeText },
      reason: "bounded reason",
    }));
    expect(new TextEncoder().encode(largeText).length).toBeLessThanOrEqual(MAX_FIELD_TEXT_LENGTH);

    const parsed = submitExecutionResultSchema.safeParse({
      ...validSubmission,
      artifacts: [],
      fieldProposals,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        message: "submission_string_bytes_exceeded",
        path: [],
      }));
    }
  });

  it("accepts a reasonable submission below the aggregate byte limit", () => {
    const parsed = submitExecutionResultSchema.parse(validSubmission);
    expect(parsed).toEqual(validSubmission);
    expect(MAX_SUBMISSION_STRING_BYTES).toBe(256 * 1_024);
  });

  it("enforces the shared epoch millisecond range", () => {
    expect(supportedFieldValueSchema.safeParse({
      type: "date", epochMilliseconds: String(MAX_EPOCH_MILLISECONDS),
    }).success).toBe(true);
    for (const epochMilliseconds of [
      "9007199254740993",
      String(MAX_EPOCH_MILLISECONDS + 1),
      "9".repeat(200),
    ]) {
      expect(supportedFieldValueSchema.safeParse({ type: "date", epochMilliseconds }).success)
        .toBe(false);
    }
  });

  it.each(["commentId", "riskLevel", "fence", "writtenState"])(
    "rejects client-supplied server field %s",
    (field) => {
      expect(submitExecutionResultSchema.safeParse({
        ...validSubmission,
        [field]: "forged",
      }).success).toBe(false);
    },
  );

  it("keeps nested client objects strict", () => {
    expect(submitExecutionResultSchema.safeParse({
      ...validSubmission,
      fieldProposals: [{
        ...validSubmission.fieldProposals[0],
        expectedCurrentValue: {
          ...validSubmission.fieldProposals[0].expectedCurrentValue,
          written: true,
        },
      }],
    }).success).toBe(false);
  });
});
