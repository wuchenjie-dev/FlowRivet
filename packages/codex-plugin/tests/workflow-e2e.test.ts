import { describe, expect, it, vi } from "vitest";

import { ExecutionService } from "../src/executions/execution-service.js";
import { InMemoryExecutionStore } from "../src/executions/execution-store.js";
import { ResultWriter } from "../src/executions/result-writer.js";
import { WritebackWorkflow } from "../src/executions/writeback-workflow.js";
import { DevelopmentWorkflow, branchForExecution } from "../src/gitlab/development-workflow.js";
import { RepositoryWorkflow } from "../src/gitlab/repository-workflow.js";

describe("Feishu Codex GitLab workflow", () => {
  it("preserves one execution from a work item through MR, pipeline and local writeback", async () => {
    const executionService = new ExecutionService({
      store: new InMemoryExecutionStore(),
      clock: () => new Date("2026-08-12T00:00:00.000Z"),
      createId: () => "execution-1",
    });
    const git = {
      inspect: vi.fn().mockResolvedValue({
        originProjectPath: "cc/flowrivet", clean: true, branch: "codex/fei-123-work-item",
        remotes: [{ remoteName: "internal", projectPath: "cc/flowrivet" }],
      }),
      clone: vi.fn(), createBranch: vi.fn(), push: vi.fn(),
    };
    const glab = {
      findMergeRequest: vi.fn().mockResolvedValue(undefined),
      createMergeRequest: vi.fn().mockResolvedValue({ iid: 9, webUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet/-/merge_requests/9" }),
      getPipeline: vi.fn().mockResolvedValue({ id: "42", status: "success", sha: "abc", webUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet/-/pipelines/42" }),
    };
    const repository = new RepositoryWorkflow({ git });
    const development = new DevelopmentWorkflow({ git, glab });

    const prepared = await executionService.prepare({
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "fei-123",
      taskLaunchMode: "handoff", executionKind: "development",
    });
    expect((await executionService.prepare({
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "fei-123",
      taskLaunchMode: "handoff", executionKind: "development",
    })).executionId).toBe(prepared.executionId);

    const local = await repository.prepare({ project: project(), localPath: "C:\\work\\flowrivet" });
    await executionService.bindRepository(prepared.executionId, {
      host: "gitlab-aiabu.ruijie.com.cn", projectId: "1", projectPath: "cc/flowrivet", localPath: local.localPath,
    });
    const branch = branchForExecution("FEI-123", "实现任务");
    await development.createBranch({ localPath: local.localPath, projectPath: "cc/flowrivet", defaultBranch: "main", branch });
    await executionService.updateGitLab(prepared.executionId, { branch });
    await development.push({ localPath: local.localPath, projectPath: "cc/flowrivet", defaultBranch: "main", branch });
    const mr = await development.openMergeRequest({ projectPath: "cc/flowrivet", branch, defaultBranch: "main", title: "实现任务", description: "结果" });
    const pipeline = await development.getPipeline("cc/flowrivet", branch);
    await executionService.updateGitLab(prepared.executionId, { mergeRequestIid: mr.iid, mergeRequestUrl: mr.webUrl, pipelineId: pipeline?.id });

    const content = new ResultWriter().build({
      executionId: prepared.executionId, artifactType: "development", revision: 1,
      summary: "实现并验证完成", repository: "cc/flowrivet", branch,
      mergeRequestUrl: mr.webUrl, pipelineStatus: pipeline?.status,
    });
    const stored = await executionService.recordArtifact(prepared.executionId, {
      artifactId: "execution-1:development:1", type: "development", revision: 1, summary: "实现并验证完成", content,
    });

    await expect(new WritebackWorkflow({}).write({ executionId: prepared.executionId, content }))
      .rejects.toMatchObject({ code: "feishu_write_capability_unsupported", localArtifact: content });
    expect(stored.state).toBe("writeback_pending");
    expect(stored.gitlab).toMatchObject({ branch, mergeRequestIid: 9, pipelineId: "42" });
    expect(git.clone).not.toHaveBeenCalled();
    expect(git.push).toHaveBeenCalledWith({ cwd: "C:\\work\\flowrivet", remoteName: "internal", branch });
  });
});

function project() {
  return {
    host: "gitlab-aiabu.ruijie.com.cn", projectId: "1", pathWithNamespace: "cc/flowrivet",
    displayName: "FlowRivet", defaultBranch: "main", httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git",
  } as const;
}
