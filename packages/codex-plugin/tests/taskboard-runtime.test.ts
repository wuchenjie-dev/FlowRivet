import { describe, expect, it, vi } from "vitest";

import type { TaskboardMcpServerOptions } from "../src/server/app.js";
import { createTaskboardRuntime } from "../src/server/taskboard-runtime.js";
import type { WorkItemSynchronizer } from "../src/work-items/work-item-service.js";

function synchronizer(): WorkItemSynchronizer {
  return {
    sync: vi.fn(),
    loadCached: vi.fn(),
    clearCached: vi.fn(),
  };
}

describe("taskboard Companion runtime", () => {
  it("creates the default synchronizer once and shares it across request servers", () => {
    const shared = synchronizer();
    const createWorkItemSynchronizer = vi.fn(() => shared);
    const captured: TaskboardMcpServerOptions[] = [];
    const runtime = createTaskboardRuntime({}, {
      createWorkItemSynchronizer,
      createMcpServer: (options) => {
        captured.push(options);
        return options;
      },
    });

    expect(runtime.createServer().workItemService).toBe(shared);
    expect(runtime.createServer().workItemService).toBe(shared);
    expect(createWorkItemSynchronizer).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(2);
  });

  it("preserves an explicitly injected synchronizer", () => {
    const injected = synchronizer();
    const createWorkItemSynchronizer = vi.fn(() => synchronizer());
    const runtime = createTaskboardRuntime({ workItemService: injected }, {
      createWorkItemSynchronizer,
      createMcpServer: (options) => options,
    });

    expect(runtime.createServer().workItemService).toBe(injected);
    expect(createWorkItemSynchronizer).not.toHaveBeenCalled();
  });
});
