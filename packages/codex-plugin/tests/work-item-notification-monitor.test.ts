import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "../src/contracts/taskboard.js";
import {
  WorkItemNotificationMonitor,
  parseNotificationInterval,
} from "../src/notifications/work-item-notification-monitor.js";

const identity = {
  profileName: "default",
  accountKey: "user-one",
  accountDisplayName: "Example User",
};

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    key: "item:1",
    providerId: "feishu-project",
    externalId: "1",
    projectExternalId: "PROJ",
    projectName: "Project",
    kind: "task",
    providerItemType: "task",
    title: "Task",
    stage: "todo",
    providerStatus: "planning",
    freshness: "fresh",
    ...overrides,
  };
}

function harness(options: { connected?: boolean; baseline?: unknown } = {}) {
  const store = {
    loadBaseline: vi.fn(async () => options.baseline as never),
    applyScan: vi.fn(async (input: { events: Array<Record<string, unknown>> }) =>
      input.events.map((event, index) => ({ ...event, id: `event-${index}` }))),
    list: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn(),
  };
  const sync = vi.fn(async () => ({ items: [item()] }));
  const notify = vi.fn(async () => undefined);
  const monitor = new WorkItemNotificationMonitor({
    activeProvider: async () => "feishu-project",
    resolveProvider: () => ({
      auth: {
        getConnection: async () => ({
          providerId: "feishu-project",
          displayName: "飞书项目",
          state: options.connected === false ? "disconnected" as const : "connected" as const,
        }),
        getSessionIdentity: () => identity,
      },
      synchronizer: { sync },
    }),
    store,
    notifier: { notify },
    clock: () => new Date("2026-08-12T00:00:00.000Z"),
    intervalSeconds: 60,
  });
  return { monitor, store, sync, notify };
}

describe("work item notification monitor", () => {
  it("skips scanning while the active provider is disconnected", async () => {
    const { monitor, sync, store } = harness({ connected: false });
    await monitor.runOnce();
    expect(sync).not.toHaveBeenCalled();
    expect(store.loadBaseline).not.toHaveBeenCalled();
  });

  it("establishes the first baseline without sending notifications", async () => {
    const { monitor, store, notify } = harness({ baseline: undefined });
    await monitor.runOnce();
    expect(store.applyScan).toHaveBeenCalledWith(expect.objectContaining({ events: [] }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("persists and sends changes found after a baseline", async () => {
    const previous = [{
      workItemKey: "item:old",
      title: "Old",
      projectName: "Project",
      stage: "todo",
      providerStatus: "planning",
      observedAt: "2026-08-11T00:00:00.000Z",
    }];
    const { monitor, store, notify } = harness({ baseline: previous });
    await monitor.runOnce();
    expect(store.applyScan).toHaveBeenCalledWith(expect.objectContaining({
      events: [expect.objectContaining({ type: "assigned" })],
    }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Task" }));
  });

  it("does not roll back persisted events when native delivery fails", async () => {
    const { monitor, store, notify } = harness({ baseline: [] });
    notify.mockRejectedValueOnce(new Error("notifications disabled"));
    await expect(monitor.runOnce()).resolves.toBeUndefined();
    expect(store.applyScan).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent scans", async () => {
    const { monitor, sync } = harness({ baseline: [] });
    await Promise.all([monitor.runOnce(), monitor.runOnce()]);
    expect(sync).toHaveBeenCalledOnce();
  });

  it("starts after a full interval and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const { monitor, sync } = harness({ baseline: [] });
      monitor.start();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(sync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(sync).toHaveBeenCalledOnce();
      monitor.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sync).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates the configured interval", () => {
    expect(parseNotificationInterval(undefined)).toBe(60);
    expect(parseNotificationInterval("30")).toBe(30);
    expect(parseNotificationInterval("3600")).toBe(3600);
    expect(() => parseNotificationInterval("29")).toThrow("FLOWRIVET_NOTIFICATION_INTERVAL_SECONDS");
    expect(() => parseNotificationInterval("1.5")).toThrow("FLOWRIVET_NOTIFICATION_INTERVAL_SECONDS");
  });
});
