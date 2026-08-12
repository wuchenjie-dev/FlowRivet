import { describe, expect, it, vi } from "vitest";

import type { TaskboardMcpServerOptions } from "../src/server/app.js";
import type { RuntimeServices } from "../src/server/runtime-services.js";
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
  it("starts and stops the shared notification monitor once", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const shared = { notificationMonitor: { start, stop } } as unknown as RuntimeServices;
    const runtime = createTaskboardRuntime({}, {
      createRuntimeServices: () => shared,
      createMcpServer: (options) => options,
    });

    runtime.start();
    runtime.start();
    runtime.stop();
    runtime.stop();

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("creates provider runtime services once and shares them across request servers", () => {
    const shared = { marker: "shared" } as unknown as RuntimeServices;
    const createRuntimeServices = vi.fn(() => shared);
    const captured: TaskboardMcpServerOptions[] = [];
    const runtime = createTaskboardRuntime({}, {
      createRuntimeServices,
      createMcpServer: (options) => {
        captured.push(options);
        return options;
      },
    });

    expect(runtime.createServer().runtimeServices).toBe(shared);
    expect(runtime.createServer().runtimeServices).toBe(shared);
    expect(createRuntimeServices).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(2);
  });

  it("shares the default provider login coordinator across request servers", () => {
    const captured: TaskboardMcpServerOptions[] = [];
    const runtime = createTaskboardRuntime({}, {
      createMcpServer: (options) => {
        captured.push(options);
        return options;
      },
    });

    const first = runtime.createServer().runtimeServices?.loginCoordinator;
    const second = runtime.createServer().runtimeServices?.loginCoordinator;

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(captured).toHaveLength(2);
  });

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
