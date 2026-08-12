import { describe, expect, it } from "vitest";
import { WritebackWorkflow } from "../src/executions/writeback-workflow.js";

describe("WritebackWorkflow", () => {
  it("preserves a local artifact and reports unsupported remote write capability", async () => {
    const workflow = new WritebackWorkflow({ writeRemote: undefined });
    await expect(workflow.write({ executionId: "execution-1", content: "summary" }))
      .rejects.toMatchObject({ code: "feishu_write_capability_unsupported", localArtifact: "summary" });
  });
});
