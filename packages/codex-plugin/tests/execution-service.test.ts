import { describe, expect, it } from "vitest";

import { InMemoryExecutionStore } from "../src/executions/execution-store.js";
import { ExecutionService } from "../src/executions/execution-service.js";

describe("ExecutionService", () => {
  it("prepares idempotently and isolates accounts", async () => {
    const service = new ExecutionService({
      store: new InMemoryExecutionStore(),
      clock: () => new Date("2026-08-12T00:00:00.000Z"),
      createId: () => "execution-1",
    });
    const input = {
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "item-1",
      taskLaunchMode: "handoff" as const,
      executionKind: "development" as const,
    };

    const first = await service.prepare(input);
    expect(await service.prepare(input)).toEqual(first);
    expect(await service.get({ ...input })).toEqual(first);
    expect(await service.get({ ...input, accountKey: "user-2" })).toBeUndefined();
    expect(first).toMatchObject({ executionKind: "pending_classification", state: "prepared" });
  });

  it("classifies idempotently and requests a repository only for development", async () => {
    const service = new ExecutionService({
      store: new InMemoryExecutionStore(), createId: () => "execution-1",
    });
    const prepared = await service.prepare({
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "item-1",
      taskLaunchMode: "handoff", executionKind: "pending_classification",
    });

    const classified = await service.classify(prepared.executionId, "development");

    expect(classified).toMatchObject({ executionKind: "development", state: "awaiting_repository" });
    expect(await service.classify(prepared.executionId, "development")).toEqual(classified);
    await expect(service.classify(prepared.executionId, "requirement_analysis"))
      .rejects.toMatchObject({ code: "execution_state_conflict" });
  });

  it.each(["requirement_analysis", "requirement_breakdown"] as const)(
    "marks %s ready without a repository",
    async (executionKind) => {
      const service = new ExecutionService({
        store: new InMemoryExecutionStore(), createId: () => `execution-${executionKind}`,
      });
      const prepared = await service.prepare({
        providerId: "feishu-project", accountKey: "user-1", workItemKey: executionKind,
        taskLaunchMode: "handoff", executionKind: "pending_classification",
      });

      expect(await service.classify(prepared.executionId, executionKind))
        .toMatchObject({ executionKind, state: "ready" });
    },
  );

  it("rejects repository replacement after branch or merge request activity", async () => {
    const store = new InMemoryExecutionStore();
    const service = new ExecutionService({ store, createId: () => "execution-1" });
    const prepared = await service.prepare({
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "item-1",
      taskLaunchMode: "handoff", executionKind: "development",
    });
    await service.bindRepository(prepared.executionId, repository("cc/one", { branch: "codex/item-1" }));

    await expect(service.bindRepository(prepared.executionId, repository("cc/two")))
      .rejects.toMatchObject({ code: "execution_repository_locked" });
  });

  it.each([
    [{ branch: "codex/item-1" }, { localPath: "C:\\work\\replacement" }],
    [{ mergeRequestIid: 9 }, { projectId: "different" }],
  ])("locks every repository identity field after GitLab activity", async (activity, replacement) => {
    const service = new ExecutionService({
      store: new InMemoryExecutionStore(), createId: () => "execution-1",
    });
    const prepared = await service.prepare({
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "item-1",
      taskLaunchMode: "handoff", executionKind: "development",
    });
    const bound = await service.bindRepository(
      prepared.executionId,
      repository("cc/one", activity),
    );

    await expect(service.bindRepository(prepared.executionId, {
      ...bound.gitlab!,
      ...replacement,
    })).rejects.toMatchObject({ code: "execution_repository_locked" });
  });

  it("returns the existing record for an identical locked repository binding", async () => {
    const store = new InMemoryExecutionStore();
    const service = new ExecutionService({ store, createId: () => "execution-1" });
    const prepared = await service.prepare({
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "item-1",
      taskLaunchMode: "handoff", executionKind: "development",
    });
    const repositoryBinding = repository("cc/one", { branch: "codex/item-1" });
    const bound = await service.bindRepository(prepared.executionId, repositoryBinding);

    expect(await service.bindRepository(prepared.executionId, repositoryBinding)).toEqual(bound);
  });

  it("rejects a reverse state transition", async () => {
    const service = new ExecutionService({
      store: new InMemoryExecutionStore(), createId: () => "execution-1",
    });
    const prepared = await service.prepare({
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "item-1",
      taskLaunchMode: "handoff", executionKind: "requirement_analysis",
    });
    await service.transition(prepared.executionId, "running");
    await expect(service.transition(prepared.executionId, "prepared"))
      .rejects.toMatchObject({ code: "execution_transition_invalid" });
  });

  it("records the same artifact revision idempotently and marks writeback pending", async () => {
    const service = new ExecutionService({
      store: new InMemoryExecutionStore(),
      clock: () => new Date("2026-08-12T00:00:00.000Z"),
      createId: () => "execution-1",
    });
    const prepared = await service.prepare({
      providerId: "feishu-project", accountKey: "user-1", workItemKey: "item-1",
      taskLaunchMode: "handoff", executionKind: "requirement_analysis",
    });
    const artifact = {
      artifactId: "execution-1:analysis:1", type: "analysis", revision: 1,
      summary: "分析完成", content: "第一版",
    };

    await service.recordArtifact(prepared.executionId, artifact);
    const updated = await service.recordArtifact(prepared.executionId, { ...artifact, content: "修订内容" });

    expect(updated.state).toBe("writeback_pending");
    expect(updated.artifacts).toHaveLength(1);
    expect(updated.artifacts[0]?.content).toBe("修订内容");
  });
});

function repository(projectPath: string, extra: Record<string, unknown> = {}) {
  return {
    host: "gitlab-aiabu.ruijie.com.cn",
    projectId: projectPath,
    projectPath,
    localPath: `C:\\work\\${projectPath.replace("/", "-")}`,
    ...extra,
  };
}
