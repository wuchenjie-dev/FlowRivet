import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { evaluateAdmissionBatch } from "../src/poc/evaluate-batch.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/tapd/abf-requirements.json", import.meta.url), "utf8"),
);

describe("ABF admission PoC", () => {
  it("evaluates user, technical, and cross-module requirements end to end", () => {
    const report = evaluateAdmissionBatch(fixture.stories, fixture.customFields);

    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.blocked).toBe(1);
    expect(report.results[0]).toMatchObject({ id: "poc-user-1", passed: true });
    expect(report.results[1]).toMatchObject({ id: "poc-tech-1", passed: true });
    expect(report.results[2]?.findings.map((finding) => finding.code)).toEqual([
      "ADM-METRIC-MISSING",
      "GATE-BLOCKING-QUESTION-OPEN",
    ]);
  });
});
