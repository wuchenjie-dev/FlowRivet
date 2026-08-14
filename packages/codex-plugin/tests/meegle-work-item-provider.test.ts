import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  MeegleCreatedWorkItemQuery,
  MeegleMyWorkPage,
  MeegleProject,
  MeegleUser,
  MeegleWorkItemType,
} from "../src/meegle/meegle-cli-contracts.js";
import { MeegleCliError, type MeegleMyWorkAction } from "../src/meegle/meegle-cli-client.js";
import {
  MeegleWorkItemProvider,
  type MeegleWorkItemClient,
} from "../src/meegle/meegle-work-item-provider.js";
import { WorkItemService } from "../src/work-items/work-item-service.js";
import { SqliteWorkItemCacheStore } from "../src/cache/sqlite-work-item-cache-store.js";

const now = new Date("2026-08-11T00:00:00.000Z");
const identity: MeegleUser = {
  name_cn: "Example User",
  name_en: "Example User",
  user_key: "user_example",
};

class FakeClient implements MeegleWorkItemClient {
  readonly getCurrentProfile = vi.fn(async () => "default");
  readonly getCurrentUser = vi.fn(async () => identity);
  readonly getMyWorkPage = vi.fn<MeegleWorkItemClient["getMyWorkPage"]>();
  readonly getProjectSimpleName = vi.fn(async (_profile: string, projectKey: string) =>
    `space-${projectKey.toLowerCase()}`);
  readonly listRecentProjects = vi.fn(async () => [] as MeegleProject[]);
  readonly listWorkItemTypes = vi.fn(async () => [] as MeegleWorkItemType[]);
  readonly queryCreatedWorkItems = vi.fn<MeegleWorkItemClient["queryCreatedWorkItems"]>();
  readonly queryCreatedWorkItemsPage = vi.fn();
}

const createdProject: MeegleProject = {
  name: "Created Project",
  project_key: "CREATED",
  simple_name: "created-space",
};
const createdType: MeegleWorkItemType = {
  api_name: "solution",
  enable_model_resource_lib: false,
  is_disable: 2,
  name: "Solution",
  type_key: "solution-key",
};

function createdQuery(items: Array<{
  id: number;
  name?: string;
  statusKey?: string;
  statusLabel?: string;
  finishTime?: string | null;
}>, options: {
  count?: number;
  sessionId?: string;
} = {}): MeegleCreatedWorkItemQuery {
  return {
    data: {
      "1": items.map((item) => ({
        moql_field_list: [
          { key: "work_item_id", name: "Item ID", value: { long_value: item.id }, value_type: "long_value" },
          { key: "name", name: "Name", value: { string_value: item.name ?? `Created ${item.id}` }, value_type: "string_value" },
          {
            key: "work_item_status", name: "Status",
            value: { key_label_value_list: [{ key: item.statusKey ?? "started", label: item.statusLabel ?? "Started" }] },
            value_type: "key_label_value_list",
          },
          {
            key: "finish_time", name: "Completion time",
            value: item.finishTime ? { string_value: item.finishTime } : null,
            value_type: "string_value",
          },
        ],
      })),
    },
    extra_info: null,
    list: [{ count: options.count ?? items.length, group_infos: [{ group_id: "1", group_name: "Group" }] }],
    search_status_info: null,
    session_id: options.sessionId ?? "session-1",
  };
}

function emptyCreatedQuery(): MeegleCreatedWorkItemQuery {
  return {
    data: {},
    extra_info: null,
    list: null,
    search_status_info: null,
    session_id: "REDACTED_SESSION_ID",
  } as unknown as MeegleCreatedWorkItemQuery;
}

function rawItem(id: number, options: {
  project?: string;
  type?: string;
  node?: string;
  nodeKey?: string;
  finish?: string;
  schedule?: [number, number];
} = {}): NonNullable<MeegleMyWorkPage["list"]>[number] {
  const project = options.project ?? "PROJ";
  return {
    ...(options.finish ? { finish_time: { finish_time: options.finish } } : {}),
    node_info: {
      node_name: options.node ?? "Planning",
      node_state_key: options.nodeKey ?? options.node ?? "planning",
    },
    project_key: project,
    project_name: `Project ${project}`,
    schedule: options.schedule ?? null,
    state_info: { end_state_key_name: "", start_state_key_name: "" },
    work_item_info: {
      work_item_id: id,
      work_item_name: `Item ${id}`,
      work_item_type_key: options.type ?? "task",
    },
  };
}

function pages(entries: Partial<Record<MeegleMyWorkAction, MeegleMyWorkPage[]>>) {
  return async (_profile: string, action: MeegleMyWorkAction, pageNum: number) =>
    entries[action]?.[pageNum - 1] ?? { list: null, total: 0 };
}

describe("Meegle work item provider", () => {
  it("adds a created-only item and its previously undiscovered project", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(createdQuery([
      { id: 7001, statusKey: "started", statusLabel: "Started" },
    ]));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });
    const items = result.scopes.flatMap((scope) => scope.items);

    expect(result.projects).toEqual([expect.objectContaining({ externalId: "CREATED", name: "Created Project" })]);
    expect(items).toEqual([expect.objectContaining({
      key: "feishu-project:CREATED:solution-key:7001",
      kind: "other",
      stage: "in_progress",
      providerStatus: "Started",
      externalUrl: "https://project.feishu.cn/created-space/solution-key/detail/7001",
    })]);
  });

  it("returns an empty created type as a successful scope that can clear cached items", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(emptyCreatedQuery());

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "CREATED", name: "Created Project" }),
    ]));
    expect(result.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectExternalId: "CREATED",
        providerItemType: "created:solution-key",
        outcome: "success",
        items: [],
      }),
    ]));
    expect(result.scopes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ providerItemType: "created:solution-key", outcome: "error" }),
    ]));
  });

  it("deduplicates a created result against mywork and preserves the richer mywork item", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      this_week: [{ list: [rawItem(42, {
        project: "CREATED", type: "solution-key", node: "Review",
        schedule: [1, Date.parse("2026-08-15T00:00:00.000Z")],
      })], total: 1 }],
    }));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(createdQuery([{ id: 42 }]));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });
    const matching = result.scopes.flatMap((scope) => scope.items)
      .filter((item) => item.externalId === "42");

    expect(matching).toHaveLength(1);
    expect(client.queryCreatedWorkItems).toHaveBeenCalledOnce();
    expect(matching[0]).toMatchObject({
      providerStatus: "Review",
      dueAt: "2026-08-15T00:00:00.000Z",
    });
  });

  it("fails a created type closed when the first page does not satisfy its reported count", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(createdQuery(
      Array.from({ length: 50 }, (_, index) => ({ id: index + 1 })),
      { count: 51, sessionId: "session-51" },
    ));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items)).toHaveLength(0);
    expect(result.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectExternalId: "CREATED",
        providerItemType: "created:solution-key",
        outcome: "error",
      }),
    ]));
    expect(client.queryCreatedWorkItemsPage).not.toHaveBeenCalled();
  });

  it("accepts an exact 50-row created first page without session pagination", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(createdQuery(
      Array.from({ length: 50 }, (_, index) => ({ id: index + 1 })),
      { count: 50 },
    ));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items)).toHaveLength(50);
    expect(client.queryCreatedWorkItemsPage).not.toHaveBeenCalled();
  });

  it("maps trusted created completion times and lets the service apply the seven-day window", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(createdQuery([
      { id: 1, statusKey: "completed", statusLabel: "Completed", finishTime: "2026-08-10T00:00:00Z" },
      { id: 2, statusKey: "completed", statusLabel: "Completed", finishTime: "2026-08-01T23:59:59Z" },
      { id: 3, statusKey: "completed", statusLabel: "Completed", finishTime: null },
    ]));
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    const providerResult = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    const completed = providerResult.scopes.flatMap((scope) => scope.items);
    expect(completed.map((item) => [item.externalId, item.completedAt])).toEqual([
      ["1", "2026-08-10T00:00:00.000Z"],
      ["2", "2026-08-01T23:59:59.000Z"],
    ]);

    const snapshot = await new WorkItemService(provider, () => now)
      .sync({ accountDisplayName: "Example User" });
    expect(snapshot.items.map((item) => item.externalId)).toEqual(["1"]);
  });

  it("does not reuse the project/type directory across stable identities", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(createdQuery([]));
    client.getCurrentUser
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce({ ...identity, user_key: "user-2" })
      .mockResolvedValueOnce({ ...identity, user_key: "user-2" });
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.listRecentProjects).toHaveBeenCalledTimes(2);
    expect(client.listWorkItemTypes).toHaveBeenCalledTimes(2);
  });

  it("isolates a created type failure while preserving mywork and successful created types", async () => {
    const client = new FakeClient();
    const failedType = { ...createdType, name: "Broken", type_key: "broken" };
    client.getMyWorkPage.mockImplementation(pages({
      todo: [{ list: [rawItem(9)], total: 1 }],
    }));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType, failedType]);
    client.queryCreatedWorkItems.mockImplementation(async (_profile, _project, type) => {
      if (type.type_key === "broken") throw new MeegleCliError("provider_unavailable");
      return createdQuery([{ id: 7001 }]);
    });

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items).map((item) => item.externalId))
      .toEqual(expect.arrayContaining(["9", "7001"]));
    expect(result.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectExternalId: "CREATED",
        providerItemType: "created:broken",
        outcome: "error",
        errorCode: "provider_unavailable",
      }),
    ]));
  });

  it("bounds created query concurrency at four", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({
      ...createdType, name: `Type ${index}`, type_key: `type-${index}`,
    })));
    let active = 0;
    let maximumActive = 0;
    client.queryCreatedWorkItems.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return createdQuery([]);
    });

    await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(maximumActive).toBeGreaterThan(1);
  });

  it("caches the project/type directory but refreshes created query results", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(createdQuery([]));
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.listRecentProjects).toHaveBeenCalledTimes(1);
    expect(client.listWorkItemTypes).toHaveBeenCalledTimes(1);
    expect(client.queryCreatedWorkItems).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized type catalogs and created result counts within the created scope", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      todo: [{ list: [rawItem(9)], total: 1 }],
    }));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(Array.from({ length: 201 }, (_, index) => ({
      ...createdType, name: `Type ${index}`, type_key: `type-${index}`,
    })));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items).map((item) => item.externalId)).toContain("9");
    expect(result.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectExternalId: "CREATED", providerItemType: "created:catalog", outcome: "error",
      }),
    ]));
    expect(client.queryCreatedWorkItems).not.toHaveBeenCalled();
  });

  it("rejects a created type reporting more than 10000 items without losing mywork", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      todo: [{ list: [rawItem(9)], total: 1 }],
    }));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(createdQuery([], { count: 10_001 }));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items).map((item) => item.externalId)).toContain("9");
    expect(result.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectExternalId: "CREATED",
        providerItemType: "created:solution-key",
        outcome: "error",
      }),
    ]));
    expect(client.queryCreatedWorkItemsPage).not.toHaveBeenCalled();
  });

  it("isolates project metadata failure while keeping mywork online", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      todo: [{ list: [rawItem(9)], total: 1 }],
    }));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockRejectedValue(new MeegleCliError("provider_unavailable"));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items).map((item) => item.externalId)).toContain("9");
    expect(result.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectExternalId: "CREATED", providerItemType: "created:catalog", outcome: "error",
      }),
    ]));
    expect(result.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "CREATED", name: "Created Project" }),
    ]));
  });

  it("retries failed project metadata within the successful directory TTL", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes
      .mockRejectedValueOnce(new MeegleCliError("provider_unavailable"))
      .mockResolvedValueOnce([createdType]);
    client.queryCreatedWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    const failed = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    const recovered = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(failed.projects).toEqual([expect.objectContaining({ externalId: "CREATED" })]);
    expect(recovered.scopes.flatMap((scope) => scope.items))
      .toEqual([expect.objectContaining({ externalId: "7001" })]);
    expect(client.listRecentProjects).toHaveBeenCalledOnce();
    expect(client.listWorkItemTypes).toHaveBeenCalledTimes(2);
  });

  it("keeps cached created items and projects when later metadata discovery fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-created-cache-"));
    try {
      const store = new SqliteWorkItemCacheStore({
        path: join(directory, "work-items.sqlite"), DatabaseSync,
      });
      const firstClient = new FakeClient();
      firstClient.getMyWorkPage.mockImplementation(pages({}));
      firstClient.listRecentProjects.mockResolvedValue([createdProject]);
      firstClient.listWorkItemTypes.mockResolvedValue([createdType]);
      firstClient.queryCreatedWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
      const syncInput = {
        accountDisplayName: "Example User",
        projects: [],
        cacheAccount: {
          providerId: "feishu-project",
          accountKey: identity.user_key,
          accountDisplayName: "Example User",
        },
      };
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: firstClient, clock: () => now }),
        () => now,
        store,
      ).sync(syncInput);

      const secondClient = new FakeClient();
      secondClient.getMyWorkPage.mockImplementation(pages({}));
      secondClient.listRecentProjects.mockResolvedValue([createdProject]);
      secondClient.listWorkItemTypes.mockRejectedValue(new MeegleCliError("provider_unavailable"));
      const second = await new WorkItemService(
        new MeegleWorkItemProvider({ client: secondClient, clock: () => now }),
        () => now,
        store,
      ).sync(syncInput);

      expect(second.dataFreshness).toBe("offline");
      expect(second.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({ externalId: "CREATED", count: 1 }),
      ]));
      expect(second.items).toEqual([
        expect.objectContaining({ externalId: "7001", freshness: "cached" }),
      ]);

      const thirdClient = new FakeClient();
      thirdClient.getMyWorkPage.mockImplementation(pages({}));
      thirdClient.listRecentProjects.mockResolvedValue([createdProject]);
      thirdClient.listWorkItemTypes.mockResolvedValue([]);
      const third = await new WorkItemService(
        new MeegleWorkItemProvider({ client: thirdClient, clock: () => now }),
        () => now,
        store,
      ).sync(syncInput);

      expect(third.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({ externalId: "CREATED", count: 0 }),
      ]));
      expect(third.items).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps cached created and mywork projects when both project discovery and actions fail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-project-authority-"));
    try {
      const store = new SqliteWorkItemCacheStore({
        path: join(directory, "work-items.sqlite"), DatabaseSync,
      });
      const firstClient = new FakeClient();
      firstClient.getMyWorkPage.mockImplementation(pages({
        todo: [{ list: [rawItem(9)], total: 1 }],
      }));
      firstClient.listRecentProjects.mockResolvedValue([createdProject]);
      firstClient.listWorkItemTypes.mockResolvedValue([createdType]);
      firstClient.queryCreatedWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
      const syncInput = {
        accountDisplayName: "Example User",
        projects: [],
        cacheAccount: {
          providerId: "feishu-project",
          accountKey: identity.user_key,
          accountDisplayName: "Example User",
        },
      };
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: firstClient, clock: () => now }),
        () => now,
        store,
      ).sync(syncInput);

      const failedClient = new FakeClient();
      failedClient.getMyWorkPage.mockRejectedValue(new MeegleCliError("provider_unavailable"));
      failedClient.listRecentProjects.mockRejectedValue(new MeegleCliError("provider_unavailable"));
      const failed = await new WorkItemService(
        new MeegleWorkItemProvider({ client: failedClient, clock: () => now }),
        () => now,
        store,
      ).sync(syncInput);

      expect(failed.dataFreshness).toBe("offline");
      expect(failed.projects.map((project) => project.externalId).sort())
        .toEqual(["CREATED", "PROJ"]);
      expect(failed.items.map((item) => item.externalId).sort()).toEqual(["7001", "9"]);
      expect(failed.items.every((item) => item.freshness === "cached")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("limits a successful recent catalog to pruning created-only projects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-project-source-authority-"));
    try {
      const store = new SqliteWorkItemCacheStore({
        path: join(directory, "work-items.sqlite"), DatabaseSync,
      });
      const firstClient = new FakeClient();
      firstClient.getMyWorkPage.mockImplementation(pages({
        todo: [{ list: [rawItem(9)], total: 1 }],
      }));
      firstClient.listRecentProjects.mockResolvedValue([createdProject]);
      firstClient.listWorkItemTypes.mockResolvedValue([createdType]);
      firstClient.queryCreatedWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
      const syncInput = {
        accountDisplayName: "Example User",
        projects: [],
        cacheAccount: {
          providerId: "feishu-project",
          accountKey: identity.user_key,
          accountDisplayName: "Example User",
        },
      };
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: firstClient, clock: () => now }),
        () => now,
        store,
      ).sync(syncInput);

      const failedActionsClient = new FakeClient();
      failedActionsClient.getMyWorkPage
        .mockRejectedValue(new MeegleCliError("provider_unavailable"));
      failedActionsClient.listRecentProjects.mockResolvedValue([]);
      const second = await new WorkItemService(
        new MeegleWorkItemProvider({ client: failedActionsClient, clock: () => now }),
        () => now,
        store,
      ).sync(syncInput);

      expect(second.projects.map((project) => project.externalId)).toEqual(["PROJ"]);
      expect(second.items).toEqual([
        expect.objectContaining({ externalId: "9", freshness: "cached" }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("clears a cached mywork-only project when every action succeeds empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-mywork-empty-"));
    try {
      const store = new SqliteWorkItemCacheStore({
        path: join(directory, "work-items.sqlite"), DatabaseSync,
      });
      const syncInput = {
        accountDisplayName: "Example User", projects: [],
        cacheAccount: {
          providerId: "feishu-project", accountKey: identity.user_key,
          accountDisplayName: "Example User",
        },
      };
      const firstClient = new FakeClient();
      firstClient.getMyWorkPage.mockImplementation(pages({
        todo: [{ list: [rawItem(9)], total: 1 }],
      }));
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: firstClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      const emptyClient = new FakeClient();
      emptyClient.getMyWorkPage.mockImplementation(pages({}));
      const emptied = await new WorkItemService(
        new MeegleWorkItemProvider({ client: emptyClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      expect(emptied.items).toEqual([]);
      expect(emptied.projects).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains only the cached action whose refresh failed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-mywork-partial-"));
    try {
      const store = new SqliteWorkItemCacheStore({
        path: join(directory, "work-items.sqlite"), DatabaseSync,
      });
      const syncInput = {
        accountDisplayName: "Example User", projects: [],
        cacheAccount: {
          providerId: "feishu-project", accountKey: identity.user_key,
          accountDisplayName: "Example User",
        },
      };
      const firstClient = new FakeClient();
      firstClient.getMyWorkPage.mockImplementation(pages({
        todo: [{ list: [rawItem(1)], total: 1 }],
        overdue: [{ list: [rawItem(2)], total: 1 }],
      }));
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: firstClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      const partialClient = new FakeClient();
      partialClient.getMyWorkPage.mockImplementation(async (_profile, action) => {
        if (action === "overdue") throw new MeegleCliError("provider_unavailable");
        return { list: null, total: 0 };
      });
      const partial = await new WorkItemService(
        new MeegleWorkItemProvider({ client: partialClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      expect(partial.items).toEqual([
        expect.objectContaining({ externalId: "2", freshness: "cached" }),
      ]);
      expect(partial.projects.map((project) => project.externalId)).toEqual(["PROJ"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("clears cached done work when a successful refresh only returns expired completions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-mywork-done-"));
    try {
      const store = new SqliteWorkItemCacheStore({
        path: join(directory, "work-items.sqlite"), DatabaseSync,
      });
      const syncInput = {
        accountDisplayName: "Example User", projects: [],
        cacheAccount: {
          providerId: "feishu-project", accountKey: identity.user_key,
          accountDisplayName: "Example User",
        },
      };
      const firstClient = new FakeClient();
      firstClient.getMyWorkPage.mockImplementation(pages({
        done: [{ list: [rawItem(3, { finish: "2026-08-10T00:00:00Z", node: "done" })], total: 1 }],
      }));
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: firstClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      const expiredClient = new FakeClient();
      expiredClient.getMyWorkPage.mockImplementation(pages({
        done: [{ list: [rawItem(4, { finish: "2026-08-01T00:00:00Z", node: "done" })], total: 1 }],
      }));
      const expired = await new WorkItemService(
        new MeegleWorkItemProvider({ client: expiredClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      expect(expired.items).toEqual([]);
      expect(expired.projects).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers fresh mywork over stale created without merging the same ID across projects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-created-stale-"));
    try {
      const store = new SqliteWorkItemCacheStore({
        path: join(directory, "work-items.sqlite"), DatabaseSync,
      });
      const syncInput = {
        accountDisplayName: "Example User", projects: [],
        cacheAccount: {
          providerId: "feishu-project", accountKey: identity.user_key,
          accountDisplayName: "Example User",
        },
      };
      const createdClient = new FakeClient();
      createdClient.getMyWorkPage.mockImplementation(pages({}));
      createdClient.listRecentProjects.mockResolvedValue([createdProject]);
      createdClient.listWorkItemTypes.mockResolvedValue([createdType]);
      createdClient.queryCreatedWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: createdClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      const myworkClient = new FakeClient();
      myworkClient.getMyWorkPage.mockImplementation(pages({
        this_week: [{
          list: [
            rawItem(7001, { project: "CREATED", type: "solution-key", node: "Review" }),
            rawItem(7001, { project: "OTHER", type: "solution-key", node: "Planning" }),
          ],
          total: 2,
        }],
      }));
      myworkClient.listRecentProjects.mockResolvedValue([createdProject]);
      myworkClient.listWorkItemTypes.mockResolvedValue([createdType]);
      myworkClient.queryCreatedWorkItems.mockRejectedValue(
        new MeegleCliError("provider_unavailable"),
      );
      const merged = await new WorkItemService(
        new MeegleWorkItemProvider({ client: myworkClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      expect(merged.items.map((item) => [
        item.projectExternalId, item.externalId, item.freshness, item.providerStatus,
      ])).toEqual([
        ["CREATED", "7001", "fresh", "Review"],
        ["OTHER", "7001", "fresh", "Planning"],
      ]);
      expect(merged.projects.map((project) => [project.externalId, project.count]))
        .toEqual([["CREATED", 1], ["OTHER", 1]]);
      expect(merged.staleScopeCount).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers fresh created over stale mywork for the same provider project item", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-mywork-stale-"));
    try {
      const store = new SqliteWorkItemCacheStore({
        path: join(directory, "work-items.sqlite"), DatabaseSync,
      });
      const syncInput = {
        accountDisplayName: "Example User", projects: [],
        cacheAccount: {
          providerId: "feishu-project", accountKey: identity.user_key,
          accountDisplayName: "Example User",
        },
      };
      const myworkClient = new FakeClient();
      myworkClient.getMyWorkPage.mockImplementation(pages({
        todo: [{
          list: [rawItem(7001, { project: "CREATED", type: "solution-key" })], total: 1,
        }],
      }));
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: myworkClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      const createdClient = new FakeClient();
      createdClient.getMyWorkPage.mockImplementation(async (_profile, action) => {
        if (action === "todo") throw new MeegleCliError("provider_unavailable");
        return { list: null, total: 0 };
      });
      createdClient.listRecentProjects.mockResolvedValue([createdProject]);
      createdClient.listWorkItemTypes.mockResolvedValue([createdType]);
      createdClient.queryCreatedWorkItems.mockResolvedValue(createdQuery([{
        id: 7001, statusKey: "started", statusLabel: "Fresh Created",
      }]));
      const merged = await new WorkItemService(
        new MeegleWorkItemProvider({ client: createdClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      expect(merged.items).toEqual([
        expect.objectContaining({
          projectExternalId: "CREATED",
          externalId: "7001",
          freshness: "fresh",
          providerStatus: "Fresh Created",
        }),
      ]);
      expect(merged.staleScopeCount).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates a cross-source primary item while retaining its secondary node", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-node-identity-"));
    try {
      const store = new SqliteWorkItemCacheStore({
        path: join(directory, "work-items.sqlite"), DatabaseSync,
      });
      const syncInput = {
        accountDisplayName: "Example User", projects: [],
        cacheAccount: {
          providerId: "feishu-project", accountKey: identity.user_key,
          accountDisplayName: "Example User",
        },
      };
      const createdClient = new FakeClient();
      createdClient.getMyWorkPage.mockImplementation(pages({}));
      createdClient.listRecentProjects.mockResolvedValue([createdProject]);
      createdClient.listWorkItemTypes.mockResolvedValue([createdType]);
      createdClient.queryCreatedWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: createdClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      const nodesClient = new FakeClient();
      nodesClient.getMyWorkPage.mockImplementation(pages({
        todo: [{
          list: [
            rawItem(7001, {
              project: "CREATED", type: "solution-key",
              node: "Agreement", nodeKey: "agreement",
            }),
            rawItem(7001, {
              project: "CREATED", type: "solution-key",
              node: "Feedback", nodeKey: "feedback",
            }),
          ],
          total: 2,
        }],
      }));
      nodesClient.listRecentProjects.mockResolvedValue([createdProject]);
      nodesClient.listWorkItemTypes.mockResolvedValue([createdType]);
      nodesClient.queryCreatedWorkItems.mockRejectedValue(
        new MeegleCliError("provider_unavailable"),
      );
      const merged = await new WorkItemService(
        new MeegleWorkItemProvider({ client: nodesClient, clock: () => now }),
        () => now, store,
      ).sync(syncInput);

      expect(merged.items.map((item) => [item.key, item.freshness])).toEqual([
        ["feishu-project:CREATED:solution-key:7001", "fresh"],
        ["feishu-project:CREATED:solution-key:7001:node:feedback", "fresh"],
      ]);
      expect(merged.projects).toEqual([
        expect.objectContaining({ externalId: "CREATED", count: 2 }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("caps created MQL queries at forty and defers whole later projects", async () => {
    const client = new FakeClient();
    const projects = Array.from({ length: 3 }, (_, index) => ({
      ...createdProject,
      name: `Project ${index + 1}`,
      project_key: `P${index + 1}`,
      simple_name: `p${index + 1}`,
    }));
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue(projects);
    client.listWorkItemTypes.mockImplementation(async (_profile, projectKey) =>
      Array.from({ length: 20 }, (_, index) => ({
        ...createdType,
        name: `${projectKey} Type ${index}`,
        type_key: `${projectKey}-type-${String(index).padStart(2, "0")}`,
      })));
    client.queryCreatedWorkItems.mockImplementation(async (_profile, project, type) => {
      if (type.type_key.endsWith("00")) throw new MeegleCliError("provider_unavailable");
      return createdQuery([]);
    });

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.queryCreatedWorkItems).toHaveBeenCalledTimes(40);
    expect(client.queryCreatedWorkItems.mock.calls.every(([, project]) =>
      project.project_key !== "P3")).toBe(true);
    const deferred = result.scopes.filter((scope) => scope.projectExternalId === "P3"
      && scope.providerItemType.startsWith("created:")
      && scope.providerItemType !== "created:catalog");
    expect(deferred)
      .toHaveLength(20);
    expect(deferred)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: "error", errorCode: "provider_unavailable" }),
      ]));
  });
  it("includes unscheduled work returned only by the complete todo query", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      todo: [{ list: [rawItem(99, { node: "not_started" })], total: 1 }],
    }));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items)).toEqual([
      expect.objectContaining({ externalId: "99", stage: "todo" }),
    ]);
    expect(client.getMyWorkPage).toHaveBeenCalledWith("default", "todo", 1);
  });

  it("keeps separate todo nodes from the same Feishu work item", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      todo: [{
        list: [
          rawItem(99, { node: "Agreement", nodeKey: "agreement" }),
          rawItem(99, { node: "Feedback", nodeKey: "feedback" }),
        ],
        total: 2,
      }],
    }));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });
    const items = result.scopes.flatMap((scope) => scope.items);

    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
    expect(items.map((item) => item.externalId)).toEqual(["99", "99"]);
    expect(items.map((item) => item.key)).toEqual([
      "feishu-project:PROJ:task:99",
      "feishu-project:PROJ:task:99:node:feedback",
    ]);
  });

  it("maps the schedule end and canonical Feishu detail URL", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      this_week: [{
        list: [rawItem(42, {
          type: "story",
          schedule: [
            Date.parse("2026-08-08T00:00:00.000Z"),
            Date.parse("2026-08-09T15:59:59.999Z"),
          ],
        })],
        total: 1,
      }],
    }));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });
    const item = result.scopes.flatMap((scope) => scope.items)[0];

    expect(item).toMatchObject({
      dueAt: "2026-08-09T15:59:59.999Z",
      externalUrl: "https://project.feishu.cn/space-proj/story/detail/42",
    });
    expect(client.getProjectSimpleName).toHaveBeenCalledOnce();
    expect(client.getProjectSimpleName).toHaveBeenCalledWith("default", "PROJ");
  });

  it("fully paginates, deduplicates active work, and derives projects", async () => {
    const client = new FakeClient();
    const firstPage = Array.from({ length: 50 }, (_, index) => rawItem(index + 1));
    client.getMyWorkPage.mockImplementation(pages({
      this_week: [
        { list: firstPage, total: 51 },
        { list: [rawItem(51, { project: "SECOND", type: "story" })], total: 51 },
      ],
      overdue: [{ list: [rawItem(1)], total: 1 }],
      done: [{ list: null, total: 0 }],
    }));
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    const result = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.projects.map((project) => project.externalId)).toEqual(["PROJ", "SECOND"]);
    const items = result.scopes.flatMap((scope) => scope.items);
    expect(items).toHaveLength(51);
    expect(items.find((item) => item.externalId === "1")?.providerStatus)
      .toContain("overdue");
    expect(client.getMyWorkPage).toHaveBeenCalledWith("default", "this_week", 2);
    expect(client.getCurrentProfile).toHaveBeenCalledTimes(2);
    expect(client.getCurrentUser).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["increases", 51, [rawItem(51), rawItem(52)], 52],
    ["decreases", 52, [rawItem(51)], 51],
  ] as const)("rejects mywork pagination when the reported total %s after page one", async (
    _direction,
    firstTotal,
    finalItems,
    finalTotal,
  ) => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      this_week: [
        {
          list: Array.from({ length: 50 }, (_, index) => rawItem(index + 1)),
          total: firstTotal,
        },
        { list: [...finalItems], total: finalTotal },
      ],
    }));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerItemType: "mywork:this_week:task",
        outcome: "error",
        errorCode: "provider_unavailable",
      }),
    ]));
  });

  it("continues past an exact 50-item total until an empty page confirms termination", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      this_week: [
        { list: Array.from({ length: 50 }, (_, index) => rawItem(index + 1)), total: 50 },
        { list: null, total: 50 },
      ],
    }));

    await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.getMyWorkPage).toHaveBeenCalledWith("default", "this_week", 2);
  });

  it("keeps only trusted completions from the inclusive seven-day window", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      done: [{
        list: [
          rawItem(1, { finish: "2026-08-04T00:00:00.000Z", node: "done" }),
          rawItem(2, { finish: "2026-08-03T23:59:59.999Z", node: "done" }),
          rawItem(3, { node: "done" }),
        ],
        total: 3,
      }],
    }));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items).map((item) => item.externalId))
      .toEqual(["1"]);
  });

  it("returns error scopes for one failed action while preserving successful actions", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(async (_profile, action) => {
      if (action === "overdue") throw new MeegleCliError("provider_unavailable");
      return action === "this_week"
        ? { list: [rawItem(1)], total: 1 }
        : { list: null, total: 0 };
    });

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.some((scope) => scope.outcome === "success" && scope.items.length === 1))
      .toBe(true);
    expect(result.scopes.filter((scope) => scope.outcome === "error"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          providerItemType: "mywork:overdue:task",
          errorCode: "provider_unavailable",
        }),
      ]));
  });

  it("rejects results when profile or stable identity changes during synchronization", async () => {
    const profileClient = new FakeClient();
    profileClient.getCurrentProfile
      .mockResolvedValueOnce("profile-a")
      .mockResolvedValueOnce("profile-b");
    profileClient.getMyWorkPage.mockImplementation(pages({}));
    await expect(new MeegleWorkItemProvider({ client: profileClient, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" }))
      .rejects.toMatchObject({ code: "provider_unauthorized" });

    const identityClient = new FakeClient();
    identityClient.getCurrentUser
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce({ ...identity, user_key: "other_user" });
    identityClient.getMyWorkPage.mockImplementation(pages({}));
    await expect(new MeegleWorkItemProvider({ client: identityClient, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" }))
      .rejects.toMatchObject({ code: "provider_unauthorized" });
  });

  it("drops invalid stable IDs and maps unknown active metadata conservatively", async () => {
    const client = new FakeClient();
    const invalid = rawItem(1);
    invalid.project_key = "";
    client.getMyWorkPage.mockImplementation(pages({
      this_week: [{
        list: [invalid, rawItem(2, { type: "custom", node: "unknown-state" })],
        total: 2,
      }],
    }));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });
    const items = result.scopes.flatMap((scope) => scope.items);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "other", stage: "todo" });
  });
});
