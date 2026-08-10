import { describe, expect, it, vi } from "vitest";

import type { ProjectRef } from "../src/contracts/projects.js";
import type { WorkItem, WorkItemKind } from "../src/contracts/taskboard.js";
import {
  WorkItemCacheError,
  type CacheAccount,
  type CachedSnapshot,
  type WorkItemCacheStore,
} from "../src/cache/work-item-cache-store.js";
import { WorkItemService } from "../src/work-items/work-item-service.js";
import {
  WorkItemProviderError,
  type WorkItemProvider,
  type WorkItemQueryResult,
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
  failedKinds: WorkItemKind[] = [],
): WorkItemQueryResult {
  const definitions = [
    { kind: "requirement" as const, providerItemType: "story" },
    { kind: "task" as const, providerItemType: "task" },
    { kind: "defect" as const, providerItemType: "bug" },
  ];
  return {
    projectExternalId,
    scopes: definitions.map(({ kind, providerItemType }) => failedKinds.includes(kind)
      ? {
          providerItemType,
          kind,
          outcome: "error" as const,
          items: [],
          errorCode: "work_item_sync_failed" as const,
        }
      : {
          providerItemType,
          kind,
          outcome: "success" as const,
          items: items
            .filter((entry) => entry.kind === kind)
            .map((entry) => ({ ...entry, projectExternalId })),
        }),
  };
}

class FakeCache implements WorkItemCacheStore {
  readonly activateAccount = vi.fn<WorkItemCacheStore["activateAccount"]>();
  readonly mergeScopes = vi.fn<WorkItemCacheStore["mergeScopes"]>();
  readonly loadActive = vi.fn<WorkItemCacheStore["loadActive"]>();
  readonly clearActive = vi.fn<WorkItemCacheStore["clearActive"]>();
  readonly purgeExpired = vi.fn<WorkItemCacheStore["purgeExpired"]>();
}

const cacheAccount: CacheAccount = {
  providerId: "tapd",
  accountKey: "user-1",
  tenantKey: "tenant-1",
  accountDisplayName: "alice",
};

function cachedSnapshot(
  scopes: CachedSnapshot["scopes"],
  projects: ProjectRef[] = [project("A")],
): CachedSnapshot {
  return {
    account: {
      providerId: "tapd",
      accountDisplayName: "alice",
    },
    projects,
    scopes,
    items: scopes.flatMap((entry) => entry.items),
    lastSuccessfulSyncAt: scopes
      .map((entry) => entry.lastSuccessfulSyncAt)
      .sort()
      .at(-1),
  };
}

function cachedScope(
  providerItemType: string,
  kind: WorkItemKind,
  items: WorkItem[],
  freshness: WorkItem["freshness"] = "cached",
) {
  return {
    projectExternalId: "A",
    providerItemType,
    kind,
    freshness,
    lastSuccessfulSyncAt: now.toISOString(),
    items: items.map((entry) => ({ ...entry, freshness })),
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
    expect(snapshot).toMatchObject({
      dataFreshness: "live",
      freshScopeCount: 3,
      staleScopeCount: 0,
      lastSuccessfulSyncAt: now.toISOString(),
      lastSyncAttemptAt: now.toISOString(),
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

  it("keeps synchronization in flight until the cache transaction completes", async () => {
    const provider = new FakeProvider();
    const cache = new FakeCache();
    let releaseCache!: (value: CachedSnapshot) => void;
    provider.listProjectWorkItems.mockResolvedValue(result("A", [item("live", "todo")]));
    cache.mergeScopes.mockReturnValue(new Promise((resolve) => {
      releaseCache = resolve;
    }));
    const service = new WorkItemService(provider, () => now, cache);
    const input = {
      accountDisplayName: "alice",
      cacheAccount,
      projects: [project("A")],
    };

    const first = service.sync(input);
    await vi.waitFor(() => expect(cache.mergeScopes).toHaveBeenCalledOnce());
    const second = service.sync(input);

    expect(second).toBe(first);
    releaseCache(cachedSnapshot([
      cachedScope("task", "task", [item("live", "todo")], "fresh"),
    ]));
    await first;
    expect(provider.listProjectWorkItems).toHaveBeenCalledTimes(1);
  });

  it("merges successful live scopes with retained cached scopes", async () => {
    const provider = new FakeProvider();
    const cache = new FakeCache();
    provider.listProjectWorkItems.mockResolvedValue(result(
      "A",
      [item("live", "todo")],
      ["defect"],
    ));
    cache.mergeScopes.mockResolvedValue(cachedSnapshot([
      cachedScope("story", "requirement", [], "fresh"),
      cachedScope("task", "task", [item("live", "todo")], "fresh"),
      cachedScope("bug", "defect", [item("cached", "todo")]),
    ]));
    const service = new WorkItemService(provider, () => now, cache);

    const snapshot = await service.sync({
      accountDisplayName: "alice",
      cacheAccount,
      projects: [project("A")],
    });

    expect(snapshot.items.map((entry) => [entry.externalId, entry.freshness]))
      .toEqual([["cached", "cached"], ["live", "fresh"]]);
    expect(snapshot).toMatchObject({
      dataFreshness: "mixed",
      freshScopeCount: 2,
      staleScopeCount: 1,
      freshnessReasonCode: "work_item_sync_failed",
      summary: { successfulProjects: 0, failedProjects: 1, itemCount: 2 },
    });
  });

  it("returns cached work when every online scope fails", async () => {
    const provider = new FakeProvider();
    const cache = new FakeCache();
    provider.listProjectWorkItems.mockRejectedValue(
      new WorkItemProviderError("provider_unavailable"),
    );
    cache.mergeScopes.mockResolvedValue(cachedSnapshot([
      cachedScope("task", "task", [item("cached", "todo")]),
    ]));
    const service = new WorkItemService(provider, () => now, cache);

    await expect(service.sync({
      accountDisplayName: "alice",
      cacheAccount,
      projects: [project("A")],
    })).resolves.toMatchObject({
      dataFreshness: "offline",
      freshScopeCount: 0,
      staleScopeCount: 1,
      freshnessReasonCode: "provider_unavailable",
      items: [expect.objectContaining({ externalId: "cached", freshness: "cached" })],
    });
  });

  it("keeps partial online data when stable cache identity is unavailable", async () => {
    const provider = new FakeProvider();
    const cache = new FakeCache();
    provider.listProjectWorkItems.mockResolvedValue(result(
      "A",
      [item("live", "todo")],
      ["defect"],
    ));
    const service = new WorkItemService(provider, () => now, cache);

    const snapshot = await service.sync({
      accountDisplayName: "alice",
      projects: [project("A")],
    });

    expect(cache.mergeScopes).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      dataFreshness: "live",
      freshScopeCount: 2,
      staleScopeCount: 0,
      cacheWarningCode: "cache_identity_unavailable",
      freshnessReasonCode: "work_item_sync_failed",
      items: [expect.objectContaining({ externalId: "live" })],
    });
  });

  it("keeps successful online scopes when the cache write fails", async () => {
    const provider = new FakeProvider();
    const cache = new FakeCache();
    provider.listProjectWorkItems.mockResolvedValue(result("A", [item("live", "todo")]));
    cache.mergeScopes.mockRejectedValue(new WorkItemCacheError("cache_write_failed"));
    const service = new WorkItemService(provider, () => now, cache);

    const snapshot = await service.sync({
      accountDisplayName: "alice",
      cacheAccount,
      projects: [project("A")],
    });

    expect(snapshot).toMatchObject({
      dataFreshness: "live",
      freshScopeCount: 3,
      staleScopeCount: 0,
      cacheWarningCode: "cache_write_failed",
      items: [expect.objectContaining({ externalId: "live", freshness: "fresh" })],
    });
  });

  it("applies completion retention after live and cached scopes are merged", async () => {
    const provider = new FakeProvider();
    const cache = new FakeCache();
    provider.listProjectWorkItems.mockResolvedValue(result("A", [
      item("live-old", "done", "2026-07-31T11:59:59.999Z"),
    ]));
    cache.mergeScopes.mockResolvedValue(cachedSnapshot([
      cachedScope("task", "task", [
        item("cached-boundary", "done", "2026-07-31T12:00:00.000Z"),
        item("cached-old", "done", "2026-07-31T11:59:59.999Z"),
      ]),
    ]));
    const service = new WorkItemService(provider, () => now, cache);

    const snapshot = await service.sync({
      accountDisplayName: "alice",
      cacheAccount,
      projects: [project("A")],
    });

    expect(snapshot.items.map((entry) => entry.externalId)).toEqual(["cached-boundary"]);
  });

  it("loads and clears cached snapshots through the provider-neutral port", async () => {
    const provider = new FakeProvider();
    const cache = new FakeCache();
    cache.loadActive.mockResolvedValue(cachedSnapshot([
      cachedScope("task", "task", [item("cached", "todo")]),
    ]));
    const service = new WorkItemService(provider, () => now, cache);

    await expect(service.loadCached("tapd")).resolves.toMatchObject({
      dataFreshness: "offline",
      freshScopeCount: 0,
      staleScopeCount: 1,
      projects: [expect.objectContaining({ externalId: "A", count: 1 })],
    });
    await service.clearCached("tapd");
    expect(cache.clearActive).toHaveBeenCalledWith("tapd");
  });

  it("uses deterministic failure precedence across provider scopes", async () => {
    const provider = new FakeProvider();
    provider.listProjectWorkItems.mockResolvedValue({
      projectExternalId: "A",
      scopes: [
        { providerItemType: "story", kind: "requirement", outcome: "error", items: [], errorCode: "work_item_sync_failed" },
        { providerItemType: "task", kind: "task", outcome: "error", items: [], errorCode: "provider_rate_limited", retryAfterSeconds: 120 },
        { providerItemType: "bug", kind: "defect", outcome: "error", items: [], errorCode: "provider_unauthorized" },
      ],
    });
    const service = new WorkItemService(provider, () => now);

    await expect(service.sync({
      accountDisplayName: "alice",
      projects: [project("A")],
    })).rejects.toMatchObject({ code: "provider_unauthorized" });
  });

  it("aggregates the maximum rate-limit cooldown into a partial snapshot", async () => {
    const provider = new FakeProvider();
    provider.listProjectWorkItems
      .mockResolvedValueOnce({
        projectExternalId: "A",
        scopes: [
          { providerItemType: "story", kind: "requirement", outcome: "success", items: [item("live", "todo")] },
          { providerItemType: "task", kind: "task", outcome: "error", items: [], errorCode: "provider_rate_limited", retryAfterSeconds: 30 },
          { providerItemType: "bug", kind: "defect", outcome: "error", items: [], errorCode: "provider_rate_limited", retryAfterSeconds: 90 },
        ],
      })
      .mockResolvedValueOnce({
        projectExternalId: "B",
        scopes: [
          { providerItemType: "story", kind: "requirement", outcome: "error", items: [], errorCode: "provider_unavailable" },
          { providerItemType: "task", kind: "task", outcome: "error", items: [], errorCode: "provider_rate_limited", retryAfterSeconds: 60 },
          { providerItemType: "bug", kind: "defect", outcome: "success", items: [] },
        ],
      });
    const service = new WorkItemService(provider, () => now);

    await expect(service.sync({
      accountDisplayName: "alice",
      projects: [project("A"), project("B")],
    })).resolves.toMatchObject({
      freshnessReasonCode: "provider_rate_limited",
      retryAfterSeconds: 90,
      summary: { successfulProjects: 0, failedProjects: 2, itemCount: 1 },
    });
  });

  it("throws rate-limit cooldown metadata when no usable scope remains", async () => {
    const provider = new FakeProvider();
    provider.listProjectWorkItems.mockRejectedValue(
      new WorkItemProviderError("provider_rate_limited", { retryAfterSeconds: 75 }),
    );
    const service = new WorkItemService(provider, () => now);

    await expect(service.sync({
      accountDisplayName: "alice",
      projects: [project("A")],
    })).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryAfterSeconds: 75,
    });
  });
});
