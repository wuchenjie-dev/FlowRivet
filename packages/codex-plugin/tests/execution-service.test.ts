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
  });

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
