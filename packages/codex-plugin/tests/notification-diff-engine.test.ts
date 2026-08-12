import { describe, expect, it } from "vitest";

import type { WorkItem } from "../src/contracts/taskboard.js";
import {
  detectWorkItemNotificationChanges,
  type NotificationItemBaseline,
} from "../src/notifications/notification-diff-engine.js";

const now = new Date("2026-08-12T00:00:00.000Z");

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    key: "feishu-project:PROJ:story:42",
    providerId: "feishu-project",
    externalId: "42",
    projectExternalId: "PROJ",
    projectName: "Project",
    kind: "requirement",
    providerItemType: "story",
    title: "Example work item",
    stage: "todo",
    providerStatus: "planning",
    freshness: "fresh",
    externalUrl: "https://project.feishu.cn/space/story/detail/42",
    ...overrides,
  };
}

function baseline(value: WorkItem): NotificationItemBaseline {
  return {
    workItemKey: value.key,
    title: value.title,
    projectName: value.projectName,
    stage: value.stage,
    providerStatus: value.providerStatus,
    dueAt: value.dueAt,
    externalUrl: value.externalUrl,
    observedAt: "2026-08-11T00:00:00.000Z",
  };
}

describe("work item notification diff engine", () => {
  it("establishes the first baseline without producing alert events", () => {
    const result = detectWorkItemNotificationChanges({
      previous: undefined,
      items: [item()],
      now,
    });

    expect(result.events).toEqual([]);
    expect(result.next).toHaveLength(1);
    expect(result.next[0]).toMatchObject({
      workItemKey: "feishu-project:PROJ:story:42",
      observedAt: now.toISOString(),
    });
  });

  it("detects an active item assigned after the baseline", () => {
    const existing = item({ externalId: "1", key: "item:1" });
    const assigned = item({ externalId: "2", key: "item:2", title: "New item" });

    const result = detectWorkItemNotificationChanges({
      previous: [baseline(existing)],
      items: [existing, assigned],
      now,
    });

    expect(result.events).toEqual([expect.objectContaining({
      workItemKey: "item:2",
      type: "assigned",
      title: "New item",
      message: "新任务已分配给你",
    })]);
  });

  it("detects status and schedule changes with deterministic dedupe material", () => {
    const previous = item({ dueAt: "2026-08-13T00:00:00.000Z" });
    const current = item({
      stage: "in_progress",
      providerStatus: "doing",
      dueAt: "2026-08-14T00:00:00.000Z",
    });

    const first = detectWorkItemNotificationChanges({
      previous: [baseline(previous)],
      items: [current],
      now,
    });
    const second = detectWorkItemNotificationChanges({
      previous: [baseline(previous)],
      items: [current],
      now,
    });

    expect(first.events.map((event) => event.type)).toEqual([
      "status_changed",
      "schedule_changed",
    ]);
    expect(first.events[0]?.message).toContain("进行中");
    expect(first.events[1]?.message).toContain("8月14日");
    expect(second.events.map((event) => event.dedupeMaterial))
      .toEqual(first.events.map((event) => event.dedupeMaterial));
  });

  it("detects schedule removal", () => {
    const previous = item({ dueAt: "2026-08-13T00:00:00.000Z" });
    const result = detectWorkItemNotificationChanges({
      previous: [baseline(previous)],
      items: [item()],
      now,
    });

    expect(result.events).toEqual([expect.objectContaining({
      type: "schedule_changed",
      message: "截止时间已移除",
    })]);
  });

  it("detects due soon once within the inclusive 24-hour window", () => {
    const current = item({ dueAt: "2026-08-13T00:00:00.000Z" });
    const previous = baseline(current);

    const result = detectWorkItemNotificationChanges({
      previous: [previous],
      items: [current],
      now,
      previousEventKeys: new Set(),
    });
    const repeated = detectWorkItemNotificationChanges({
      previous: [previous],
      items: [current],
      now,
      previousEventKeys: new Set(result.events.map((event) => event.dedupeMaterial)),
    });

    expect(result.events).toEqual([expect.objectContaining({ type: "due_soon" })]);
    expect(repeated.events).toEqual([]);
  });

  it("detects overdue but does not notify due states for completed items", () => {
    const overdue = item({ dueAt: "2026-08-11T23:59:59.999Z" });
    const completed = item({
      key: "item:done",
      stage: "done",
      dueAt: "2026-08-11T00:00:00.000Z",
    });

    const result = detectWorkItemNotificationChanges({
      previous: [baseline(overdue), baseline(completed)],
      items: [overdue, completed],
      now,
    });

    expect(result.events).toEqual([expect.objectContaining({
      workItemKey: overdue.key,
      type: "overdue",
    })]);
  });

  it("ignores cached items and invalid dates when generating time alerts", () => {
    const cached = item({ freshness: "cached", dueAt: "2026-08-12T01:00:00.000Z" });
    const invalid = item({ key: "item:invalid", dueAt: "invalid" });

    const result = detectWorkItemNotificationChanges({
      previous: [baseline(cached), baseline(invalid)],
      items: [cached, invalid],
      now,
    });

    expect(result.events).toEqual([]);
  });
});
