import { describe, expect, it, vi } from "vitest";

import { DevelopmentWorkflow, branchForExecution } from "../src/gitlab/development-workflow.js";

describe("development workflow", () => {
  it("creates a stable safe branch name", () => {
    expect(branchForExecution("115039606200100017", "自然语言配置检测规则"))
      .toBe("codex/115039606200100017-work-item");
  });

  it("refuses the default branch and reuses an existing merge request", async () => {
    const git = { inspect: vi.fn().mockResolvedValue({ clean: true, branch: "main", remotes: [{ remoteName: "internal", projectPath: "cc/flowrivet" }] }), push: vi.fn() };
    const glab = { findMergeRequest: vi.fn().mockResolvedValue({ iid: 9, webUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet/-/merge_requests/9" }), createMergeRequest: vi.fn(), getPipeline: vi.fn() };
    const workflow = new DevelopmentWorkflow({ git, glab });
    await expect(workflow.push({ localPath: "C:\\work\\flowrivet", projectPath: "cc/flowrivet", branch: "main", defaultBranch: "main" }))
      .rejects.toThrow("development_default_branch_forbidden");
    await expect(workflow.openMergeRequest({ projectPath: "cc/flowrivet", branch: "codex/item", defaultBranch: "main", title: "Work", description: "Summary" }))
      .resolves.toMatchObject({ iid: 9 });
    expect(glab.createMergeRequest).not.toHaveBeenCalled();
  });
});
