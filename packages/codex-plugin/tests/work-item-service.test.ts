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
  type AccountWorkItemQueryResult,
  type AccountScopedWorkItemProvider,
  type ProjectScopedWorkItemProvider,
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

class FakeProvider implements ProjectScopedWorkItemProvider {
  readonly id = "tapd";
  readonly queryMode = "project_scoped" as const;
  readonly listProjectWorkItems = vi.fn<ProjectScopedWorkItemProvider["listProjectWorkItems"]>();
}

class FakeAccountProvider implements AccountScopedWorkItemProvider {
  readonly id = "feishu-project";
  readonly queryMode = "account_scoped" as const;
  readonly listAccountWorkItems = vi.fn<AccountScopedWorkItemProvider["listAccountWorkItems"]>();
}

function accountProject(externalId: string): ProjectRef {
  return {
    providerId: "feishu-project",
    externalId,
    name: `Feishu Project ${externalId}`,
    selected: true,
    available: true,
    source: "discovered",
    lastVerifiedAt: now.toISOString(),
  };
}

function accountItem(externalId: string, projectExternalId = "PROJ"): WorkItem {
  return {
    key: `feishu-project:${projectExternalId}:task:${externalId}`,
    providerId: "feishu-project",
    externalId,
    projectExternalId,
    projectName: `Feishu Project ${projectExternalId}`,
    kind: "task",
    providerItemType: "task",
    title: `Feishu item ${externalId}`,
    stage: "todo",
    providerStatus: "started",
    freshness: "fresh",
  };
}

function accountResult(
  projects: ProjectRef[],
  scopes: AccountWorkItemQueryResult["scopes"],
): AccountWorkItemQueryResult {
  return { projects, scopes };
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
  readonly loadAccount = vi.fn<WorkItemCacheStore["loadAccount"]>();
  readonly clearActive = vi.fn<WorkItemCacheStore["clearActive"]>();
  readonly purgeExpired = vi.fn<WorkItemCacheStore["purgeExpired"]>();
}

function feishuCacheAccount(overrides: Partial<CacheAccount> = {}): CacheAccount {
  return {
    providerId: "feishu-project",
    accountKey: "user-1",
    tenantKey: "tenant-1",
    accountDisplayName: "alice",
    ...overrides,
  };
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
  it("loads cached data for the exact account without consulting the active provider cache", async () => {
    const provider = new FakeAccountProvider();
    const cache = new FakeCache();
    const bob = feishuCacheAccount({ accountKey: "user-B", accountDisplayName: "bob" });
    cache.loadAccount.mockImplementation(async (value) =>
      value.accountKey === "user-B"
        ? cachedSnapshot([cachedScope("task", "task", [item("B-cached", "todo")])])
        : undefined);
    const service = new WorkItemService(provider, () => now, cache);

    const [missing, exact] = await Promise.all([
      service.loadCachedAccount(feishuCacheAccount({ accountKey: "user-A" })),
      service.loadCachedAccount(bob),
    ]);

    expect(missing).toBeUndefined();
    expect(exact).toMatchObject({
      dataFreshness: "offline",
      items: [{ externalId: "B-cached" }],
    });
    expect(cache.loadActive).not.toHaveBeenCalled();
    expect(cache.loadAccount).toHaveBeenCalledWith(bob, now);
  });

  it("preloads the exact account and pure-merges it when the cache write fails", async () => {
    const provider = new FakeAccountProvider();
    const cache = new FakeCache();
    const cached = cachedSnapshot([
      cachedScope("created:unscanned", "other", [item("cached", "todo")]),
    ]);
    cache.loadAccount.mockResolvedValue(cached);
    cache.mergeScopes.mockRejectedValue(new WorkItemCacheError("cache_write_failed"));
    provider.listAccountWorkItems.mockResolvedValue({
      projects: [accountProject("A")],
      scopes: [],
      authoritativeScopeInventories: [{
        projectExternalId: "A",
        providerItemTypePrefix: "created:",
        providerItemTypes: ["created:unscanned"],
      }],
    });
    const service = new WorkItemService(provider, () => now, cache);

    const snapshot = await service.sync({
      accountDisplayName: "alice",
      cacheAccount: feishuCacheAccount(),
      projects: [],
    });

    expect(cache.loadAccount).toHaveBeenCalledWith(feishuCacheAccount(), now);
    expect(cache.loadActive).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      cacheWarningCode: "cache_write_failed",
      cacheDiagnosticCodes: ["cache_write_failed"],
      staleScopeCount: 1,
      items: [{ externalId: "cached" }],
    });
  });

  it.each([
    { readFails: false, writeFails: false, warning: undefined, diagnostics: [] },
    { readFails: true, writeFails: false, warning: "cache_read_failed", diagnostics: ["cache_read_failed"] },
    { readFails: false, writeFails: true, warning: "cache_write_failed", diagnostics: ["cache_write_failed"] },
    { readFails: true, writeFails: true, warning: "cache_write_failed", diagnostics: ["cache_read_failed", "cache_write_failed"] },
  ])("reports the cache read/write matrix: $diagnostics", async ({ readFails, writeFails, warning, diagnostics }) => {
    const provider = new FakeAccountProvider();
    const cache = new FakeCache();
    const live = cachedSnapshot([], [accountProject("A")]);
    if (readFails) cache.loadAccount.mockRejectedValue(new WorkItemCacheError("cache_read_failed"));
    else cache.loadAccount.mockResolvedValue(undefined);
    if (writeFails) cache.mergeScopes.mockRejectedValue(new WorkItemCacheError("cache_write_failed"));
    else cache.mergeScopes.mockResolvedValue(live);
    provider.listAccountWorkItems.mockResolvedValue(accountResult([accountProject("A")], []));
    const service = new WorkItemService(provider, () => now, cache);

    const snapshot = await service.sync({
      accountDisplayName: "alice",
      cacheAccount: feishuCacheAccount(),
      projects: [],
    });

    expect(snapshot.cacheWarningCode).toBe(warning);
    expect(snapshot.cacheDiagnosticCodes).toEqual(diagnostics);
  });

  it("uses live-only account B data when exact preload and cache write both fail", async () => {
    const provider = new FakeAccountProvider();
    const cache = new FakeCache();
    cache.loadAccount.mockRejectedValue(new WorkItemCacheError("cache_read_failed"));
    cache.mergeScopes.mockRejectedValue(new WorkItemCacheError("cache_write_failed"));
    provider.listAccountWorkItems.mockResolvedValue({
      projects: [accountProject("B")],
      scopes: [{
        projectExternalId: "B",
        providerItemType: "created:task",
        kind: "task",
        outcome: "success",
        items: [{ ...accountItem("B-live", "B"), projectName: "Feishu Project B" }],
      }],
    });
    const service = new WorkItemService(provider, () => now, cache);

    const snapshot = await service.sync({
      accountDisplayName: "bob",
      cacheAccount: feishuCacheAccount({ accountKey: "user-B", accountDisplayName: "bob" }),
      projects: [],
    });

    expect(snapshot.projects.map((entry) => entry.externalId)).toEqual(["B"]);
    expect(snapshot.items.map((entry) => entry.externalId)).toEqual(["B-live"]);
    expect(snapshot).toMatchObject({
      cacheWarningCode: "cache_write_failed",
      cacheDiagnosticCodes: ["cache_read_failed", "cache_write_failed"],
    });
  });

  it("maps malformed inventory fallback to cache_write_failed without restoring deleted cache", async () => {
    const provider = new FakeAccountProvider();
    const cache = new FakeCache();
    cache.loadAccount.mockResolvedValue(cachedSnapshot([
      cachedScope("created:old", "other", [item("old", "todo")]),
    ]));
    cache.mergeScopes.mockRejectedValue(new WorkItemCacheError("cache_write_failed"));
    provider.listAccountWorkItems.mockResolvedValue({
      projects: [accountProject("A")],
      scopes: [],
      authoritativeScopeInventories: [{
        projectExternalId: "A",
        providerItemTypePrefix: "created:",
        providerItemTypes: ["created:x", "created:x"],
      }],
    });
    const service = new WorkItemService(provider, () => now, cache);

    await expect(service.sync({
      accountDisplayName: "alice",
      cacheAccount: feishuCacheAccount(),
      projects: [],
    })).resolves.toMatchObject({
      items: [],
      cacheWarningCode: "cache_write_failed",
      cacheDiagnosticCodes: ["cache_write_failed"],
    });
  });
  it("synchronizes one account-scoped query without prior project discovery", async () => {
    const provider = new FakeAccountProvider();
    provider.listAccountWorkItems.mockResolvedValue(accountResult(
      [accountProject("PROJ")],
      [{
        projectExternalId: "PROJ",
        providerItemType: "task",
        kind: "task",
        outcome: "success",
        items: [accountItem("10001")],
      }],
    ));
    const service = new WorkItemService(provider, () => now);

    const snapshot = await service.sync({
      accountDisplayName: "Example User",
      projects: [],
      syncSessionKey: "default",
    });

    expect(provider.listAccountWorkItems).toHaveBeenCalledOnce();
    expect(provider.listAccountWorkItems).toHaveBeenCalledWith({
      accountDisplayName: "Example User",
      refreshMode: "manual",
      syncSessionKey: "default",
    });
    expect(snapshot.projects).toEqual([
      expect.objectContaining({ providerId: "feishu-project", externalId: "PROJ", count: 1 }),
    ]);
    expect(snapshot.items[0]).toMatchObject({
      providerId: "feishu-project",
      projectExternalId: "PROJ",
    });
    expect(snapshot.summary).toEqual({
      successfulProjects: 1,
      failedProjects: 0,
      itemCount: 1,
    });
  });

  it("merges account-scoped projects into cache without an input project catalog", async () => {
    const provider = new FakeAccountProvider();
    const cache = new FakeCache();
    const projects = [accountProject("PROJ")];
    const scopes: AccountWorkItemQueryResult["scopes"] = [{
      projectExternalId: "PROJ",
      providerItemType: "task",
      kind: "task",
      outcome: "success",
      items: [accountItem("10001")],
    }];
    provider.listAccountWorkItems.mockResolvedValue(accountResult(projects, scopes));
    cache.mergeScopes.mockResolvedValue({
      account: { providerId: "feishu-project", accountDisplayName: "Example User" },
      projects,
      scopes: [{
        ...scopes[0]!,
        freshness: "fresh",
        lastSuccessfulSyncAt: now.toISOString(),
      }],
      items: [accountItem("10001")],
      lastSuccessfulSyncAt: now.toISOString(),
    });
    const service = new WorkItemService(provider, () => now, cache);
    const account = {
      providerId: "feishu-project",
      accountKey: "user-example",
      accountDisplayName: "Example User",
    };

    await service.sync({
      accountDisplayName: "Example User",
      cacheAccount: account,
      projects: [],
      syncSessionKey: "default",
    });

    expect(cache.mergeScopes).toHaveBeenCalledWith({
      account,
      projects,
      scopes,
      now,
    });
  });

  it("keeps successful account scopes when another project scope fails", async () => {
    const provider = new FakeAccountProvider();
    provider.listAccountWorkItems.mockResolvedValue(accountResult(
      [accountProject("A"), accountProject("B")],
      [{
        projectExternalId: "A",
        providerItemType: "task",
        kind: "task",
        outcome: "success",
        items: [accountItem("A-1", "A")],
      }, {
        projectExternalId: "B",
        providerItemType: "task",
        kind: "task",
        outcome: "error",
        items: [],
        errorCode: "provider_unavailable",
      }],
    ));
    const service = new WorkItemService(provider, () => now);

    const snapshot = await service.sync({
      accountDisplayName: "Example User",
      projects: [],
    });

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.summary).toEqual({
      successfulProjects: 1,
      failedProjects: 1,
      itemCount: 1,
    });
    expect(snapshot.freshnessReasonCode).toBe("provider_unavailable");
  });

  it("rejects an account result with no usable scope", async () => {
    const provider = new FakeAccountProvider();
    provider.listAccountWorkItems.mockResolvedValue(accountResult(
      [],
      [{
        projectExternalId: "PROJ",
        providerItemType: "task",
        kind: "task",
        outcome: "error",
        items: [],
        errorCode: "provider_unavailable",
      }],
    ));
    const service = new WorkItemService(provider, () => now);

    await expect(service.sync({
      accountDisplayName: "Example User",
      projects: [],
    })).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("isolates account synchronization by profile but not input project selection", async () => {
    const provider = new FakeAccountProvider();
    const releases: Array<(value: AccountWorkItemQueryResult) => void> = [];
    provider.listAccountWorkItems.mockImplementation(() =>
      new Promise((resolve) => releases.push(resolve)),
    );
    const service = new WorkItemService(provider, () => now);
    const account = {
      providerId: "feishu-project",
      accountKey: "user-example",
      accountDisplayName: "Example User",
    };
    const base = {
      accountDisplayName: "Example User",
      cacheAccount: account,
      syncSessionKey: "profile-a",
    };

    const first = service.sync({ ...base, projects: [] });
    const sameProfile = service.sync({ ...base, projects: [accountProject("IGNORED")] });
    const otherProfile = service.sync({
      ...base,
      projects: [],
      syncSessionKey: "profile-b",
    });

    expect(sameProfile).toBe(first);
    expect(otherProfile).not.toBe(first);
    await vi.waitFor(() => expect(provider.listAccountWorkItems).toHaveBeenCalledTimes(2));
    releases.forEach((release) => release(accountResult([], [])));
    await Promise.all([first, sameProfile, otherProfile]);
  });

  it("passes the requested refresh mode and publishes created-item coverage", async () => {
    const provider = new FakeAccountProvider();
    provider.listAccountWorkItems.mockResolvedValue({
      ...accountResult([accountProject("PROJ")], [{
        projectExternalId: "PROJ",
        providerItemType: "task",
        kind: "task",
        outcome: "success",
        items: [accountItem("1")],
      }]),
      createdSyncCoverage: {
        catalog: "available",
        mode: "automatic",
        scannedTypeCount: 2,
        totalTypeCount: 4,
        complete: false,
      },
    });
    const service = new WorkItemService(provider, () => now);

    const automatic = await service.sync({
      accountDisplayName: "Example User",
      projects: [],
      refreshMode: "automatic",
    });
    await service.sync({ accountDisplayName: "Example User", projects: [] });

    expect(provider.listAccountWorkItems).toHaveBeenNthCalledWith(1, {
      accountDisplayName: "Example User",
      refreshMode: "automatic",
    });
    expect(provider.listAccountWorkItems).toHaveBeenNthCalledWith(2, {
      accountDisplayName: "Example User",
      refreshMode: "manual",
    });
    expect(automatic.createdSyncCoverage).toEqual({
      catalog: "available",
      mode: "automatic",
      scannedTypeCount: 2,
      totalTypeCount: 4,
      complete: false,
    });
  });

  it("coordinates overlapping automatic and manual account refreshes by mode", async () => {
    const provider = new FakeAccountProvider();
    const releases: Array<(value: AccountWorkItemQueryResult) => void> = [];
    provider.listAccountWorkItems.mockImplementation(() =>
      new Promise((resolve) => releases.push(resolve)),
    );
    const service = new WorkItemService(provider, () => now);
    const base = {
      accountDisplayName: "Example User",
      projects: [],
      cacheAccount: feishuCacheAccount(),
      syncSessionKey: "default",
    };

    const automatic = service.sync({ ...base, refreshMode: "automatic" as const });
    const automaticAgain = service.sync({ ...base, refreshMode: "automatic" as const });
    const queuedManual = service.sync({ ...base, refreshMode: "manual" as const });
    const queuedManualAgain = service.sync({ ...base, refreshMode: "manual" as const });
    const automaticWhileQueued = service.sync({ ...base, refreshMode: "automatic" as const });

    expect(automaticAgain).toBe(automatic);
    expect(automaticWhileQueued).toBe(automatic);
    expect(queuedManualAgain).toBe(queuedManual);
    expect(queuedManual).not.toBe(automatic);
    expect(provider.listAccountWorkItems).toHaveBeenCalledTimes(1);
    releases[0]!(accountResult([], []));
    await automatic;
    await vi.waitFor(() => expect(provider.listAccountWorkItems).toHaveBeenCalledTimes(2));
    const automaticDuringManual = service.sync({ ...base, refreshMode: "automatic" as const });
    expect(automaticDuringManual).toBe(queuedManual);
    releases[1]!(accountResult([], []));
    await Promise.all([queuedManual, queuedManualAgain, automaticDuringManual]);
    expect(provider.listAccountWorkItems.mock.calls.map(([input]) => input.refreshMode))
      .toEqual(["automatic", "manual"]);
  });

  it("runs a queued manual refresh after an automatic failure and clears coordination state", async () => {
    const provider = new FakeAccountProvider();
    let rejectAutomatic!: (error: Error) => void;
    provider.listAccountWorkItems
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectAutomatic = reject; }))
      .mockResolvedValue(accountResult([], []));
    const service = new WorkItemService(provider, () => now);
    const base = {
      accountDisplayName: "Example User",
      projects: [],
      cacheAccount: feishuCacheAccount(),
    };

    const automatic = service.sync({ ...base, refreshMode: "automatic" });
    const manual = service.sync({ ...base, refreshMode: "manual" });
    rejectAutomatic(new Error("automatic failed"));

    await expect(automatic).rejects.toMatchObject({ code: "work_item_sync_failed" });
    await expect(manual).resolves.toMatchObject({ summary: { failedProjects: 0 } });
    await expect(service.sync({ ...base, refreshMode: "automatic" })).resolves.toBeDefined();
    expect(provider.listAccountWorkItems).toHaveBeenCalledTimes(3);
  });

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
    const input = {
      accountDisplayName: "alice",
      cacheAccount,
      projects: [project("A")],
    };

    const first = service.sync(input);
    const second = service.sync(input);

    expect(second).toBe(first);
    release(result("A"));
    await expect(first).resolves.toMatchObject({ summary: { successfulProjects: 1 } });
    expect(provider.listProjectWorkItems).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["account", { ...cacheAccount, accountKey: "user-2" }, [project("A")]],
    ["tenant", { ...cacheAccount, tenantKey: "tenant-2" }, [project("A")]],
    ["project set", cacheAccount, [project("B")]],
  ])("does not share an in-flight synchronization across a different %s", async (
    _case,
    otherAccount,
    otherProjects,
  ) => {
    const provider = new FakeProvider();
    const releases: Array<(value: WorkItemQueryResult) => void> = [];
    provider.listProjectWorkItems.mockImplementation(({ projectExternalId }) =>
      new Promise((resolve) => releases.push((value) => resolve({
        ...value,
        projectExternalId,
      }))),
    );
    const service = new WorkItemService(provider, () => now);

    const first = service.sync({
      accountDisplayName: "alice",
      cacheAccount,
      projects: [project("A")],
    });
    const second = service.sync({
      accountDisplayName: "alice",
      cacheAccount: otherAccount,
      projects: otherProjects,
    });

    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(provider.listProjectWorkItems).toHaveBeenCalledTimes(2));
    releases.forEach((release, index) => release(result(index === 0 ? "A" : otherProjects[0]!.externalId)));
    await Promise.all([first, second]);
  });

  it("does not share in-flight work when stable account identity is missing", async () => {
    const provider = new FakeProvider();
    const releases: Array<(value: WorkItemQueryResult) => void> = [];
    provider.listProjectWorkItems.mockImplementation(() =>
      new Promise((resolve) => releases.push(resolve)),
    );
    const service = new WorkItemService(provider, () => now);
    const input = { accountDisplayName: "alice", projects: [project("A")] };

    const first = service.sync(input);
    const second = service.sync(input);

    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(provider.listProjectWorkItems).toHaveBeenCalledTimes(2));
    releases.forEach((release) => release(result("A")));
    await Promise.all([first, second]);
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

  it("binds provider requests to the stable cache identity", async () => {
    const provider = new FakeProvider();
    provider.listProjectWorkItems.mockResolvedValue(result("A"));
    const service = new WorkItemService(provider, () => now);

    await service.sync({
      accountDisplayName: "alice",
      cacheAccount,
      projects: [project("A")],
    });

    expect(provider.listProjectWorkItems).toHaveBeenCalledWith(expect.objectContaining({
      accountKey: "user-1",
      tenantKey: "tenant-1",
    }));
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
