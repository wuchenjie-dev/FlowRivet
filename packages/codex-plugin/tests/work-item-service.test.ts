import { describe, expect, it, vi } from "vitest";

import type { ProjectRef } from "../src/contracts/projects.js";
import type { WorkItem } from "../src/contracts/taskboard.js";
import { WorkItemService } from "../src/work-items/work-item-service.js";
import type {
  WorkItemProvider,
  WorkItemQueryResult,
} from "../src/work-items/work-item-provider.js";

const now = new Date("2026-08-07T12:00:00.000Z");

function project(externalId: string, available = true): ProjectRef {
  return {
    providerId: "tapd",
    externalId,
    name: `Project ${externalId}`,
    selected: false,
    available,
    source: "discovered",
    lastVerifiedAt: now.toISOString(),
  };
}

function item(
  externalId: string,
  stage: WorkItem["stage"],
  completedAt?: string,
): WorkItem {
  return {
    key: `tapd:A:task:${externalId}`,
    providerId: "tapd",
    externalId,
    projectExternalId: "A",
    projectName: "Project A",
    kind: "task",
    providerItemType: "task",
    title: `Item ${externalId}`,
    stage,
    providerStatus: stage,
    freshness: "fresh",
    ...(completedAt ? { completedAt } : {}),
    externalUrl: `https://example.test/${externalId}`,
  };
}

class FakeProvider implements WorkItemProvider {
  readonly id = "tapd";
  readonly listProjectWorkItems = vi.fn<WorkItemProvider["listProjectWorkItems"]>();
}

function result(
  projectExternalId: string,
  items: WorkItem[] = [],
  failedKinds: WorkItemQueryResult["failedKinds"] = [],
): WorkItemQueryResult {
  return {
    projectExternalId,
    items: items.map((entry) => ({ ...entry, projectExternalId })),
    failedKinds,
  };
}

describe("work item service", () => {
  it("keeps unfinished items and only trusted completions from the last seven days", async () => {
    const provider = new FakeProvider();
    provider.listProjectWorkItems.mockResolvedValue(result("A", [
      item("open", "todo"),
      item("recent", "done", "2026-08-01T12:00:00.000Z"),
      item("boundary", "done", "2026-07-31T12:00:00.000Z"),
      item("old", "done", "2026-07-31T11:59:59.999Z"),
      item("untrusted", "done"),
    ]));
    const service = new WorkItemService(provider, () => now);

    const snapshot = await service.sync({
      accountDisplayName: "alice",
      projects: [project("A")],
    });

    expect(snapshot.items.map((entry) => entry.externalId))
      .toEqual(["boundary", "open", "recent"]);
    expect(snapshot.projects).toEqual([
      expect.objectContaining({ externalId: "A", count: 3 }),
    ]);
    expect(snapshot.summary).toEqual({
      successfulProjects: 1,
      failedProjects: 0,
      itemCount: 3,
    });
  });

  it("ignores unavailable projects and limits project concurrency to four", async () => {
    const provider = new FakeProvider();
    let active = 0;
    let maximum = 0;
    provider.listProjectWorkItems.mockImplementation(async ({ projectExternalId }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return result(projectExternalId);
    });
    const service = new WorkItemService(provider, () => now);

    await service.sync({
      accountDisplayName: "alice",
      projects: [
        project("A"), project("B"), project("C"), project("D"), project("E"),
        project("hidden", false),
      ],
    });

    expect(provider.listProjectWorkItems).toHaveBeenCalledTimes(5);
    expect(maximum).toBe(4);
  });

  it("returns successful data and counts a type-level project failure", async () => {
    const provider = new FakeProvider();
    provider.listProjectWorkItems
      .mockResolvedValueOnce(result("A", [item("A-1", "todo")]))
      .mockResolvedValueOnce(result("B", [item("B-1", "todo")], ["defect"]));
    const service = new WorkItemService(provider, () => now);

    const snapshot = await service.sync({
      accountDisplayName: "alice",
      projects: [project("A"), project("B")],
    });

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.summary).toEqual({
      successfulProjects: 1,
      failedProjects: 1,
      itemCount: 2,
    });
  });

  it("rejects when every project fails and no usable data remains", async () => {
    const provider = new FakeProvider();
    provider.listProjectWorkItems.mockRejectedValue(new Error("upstream failed"));
    const service = new WorkItemService(provider, () => now);

    await expect(service.sync({
      accountDisplayName: "alice",
      projects: [project("A"), project("B")],
    })).rejects.toMatchObject({ code: "work_item_sync_failed" });
  });

  it("shares one in-flight synchronization between concurrent callers", async () => {
    const provider = new FakeProvider();
    let release!: (value: WorkItemQueryResult) => void;
    provider.listProjectWorkItems.mockReturnValue(new Promise((resolve) => {
      release = resolve;
    }));
    const service = new WorkItemService(provider, () => now);
    const input = { accountDisplayName: "alice", projects: [project("A")] };

    const first = service.sync(input);
    const second = service.sync(input);

    expect(second).toBe(first);
    release(result("A"));
    await expect(first).resolves.toMatchObject({ summary: { successfulProjects: 1 } });
    expect(provider.listProjectWorkItems).toHaveBeenCalledTimes(1);
  });
});
