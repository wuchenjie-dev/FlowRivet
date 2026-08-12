import { describe, expect, it } from "vitest";
import { ResultWriter } from "../src/executions/result-writer.js";

describe("ResultWriter", () => {
  it("creates a bounded structured local artifact with an idempotency marker", () => {
    const result = new ResultWriter().build({ executionId: "execution-1", artifactType: "analysis", revision: 1, summary: "完成需求分析", repository: "cc/flowrivet", branch: "codex/item", mergeRequestUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet/-/merge_requests/9", pipelineStatus: "success" });
    expect(result).toContain("<!-- flowrivet:execution=execution-1;artifact=analysis;revision=1 -->");
    expect(result).toContain("完成需求分析");
    expect(result.length).toBeLessThan(8_000);
  });
});
