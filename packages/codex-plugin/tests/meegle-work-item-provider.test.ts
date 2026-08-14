import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  MeegleCreatedBaseQuery,
  MeegleCreatedCompletionQuery,
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
import type {
  CreatedSyncDiagnosticEvent,
  CreatedSyncDiagnosticLogger,
} from "../src/observability/created-sync-diagnostic-logger.js";

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
  readonly hasCreatedOwnerField = vi.fn(async () => true);
  readonly queryCreatedBaseWorkItems = vi.fn<MeegleWorkItemClient["queryCreatedBaseWorkItems"]>();
  readonly queryCreatedCompletionWorkItems = vi.fn<MeegleWorkItemClient["queryCreatedCompletionWorkItems"]>();
  readonly queryCreatedBaseWorkItemsPage = vi.fn();
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

function createdBaseQuery(items: Array<{
  id: number;
  name?: string;
  statusKey?: string;
  statusLabel?: string;
}>, options: {
  count?: number;
  sessionId?: string;
} = {}): MeegleCreatedBaseQuery {
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
        ],
      })),
    },
    extra_info: null,
    list: [{ count: options.count ?? items.length, group_infos: [{ group_id: "1", group_name: "Group" }] }],
    search_status_info: null,
    session_id: options.sessionId ?? "session-1",
  };
}

function createdCompletionQuery(items: Array<{
  id: number;
  name?: string;
  statusKey?: string;
  statusLabel?: string;
  finishTime?: string | null;
}>, options: { count?: number; sessionId?: string } = {}): MeegleCreatedCompletionQuery {
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
    session_id: options.sessionId ?? "session-completion-1",
  };
}

const createdQuery = createdBaseQuery;

function emptyCreatedQuery(): MeegleCreatedBaseQuery {
  return {
    data: {},
    extra_info: null,
    list: null,
    search_status_info: null,
    session_id: "REDACTED_SESSION_ID",
  } as unknown as MeegleCreatedBaseQuery;
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
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([
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
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());

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

  it("treats a type without an owner field as an authoritative successful empty scope", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.hasCreatedOwnerField.mockResolvedValue(false);

    const provider = new MeegleWorkItemProvider({ client, clock: () => now });
    const result = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.hasCreatedOwnerField).toHaveBeenCalledOnce();
    expect(client.queryCreatedBaseWorkItems).not.toHaveBeenCalled();
    expect(result.scopes).toEqual(expect.arrayContaining([expect.objectContaining({
      projectExternalId: "CREATED",
      providerItemType: "created:solution-key",
      outcome: "success",
      items: [],
    })]));
    expect(result.createdSyncCoverage).toEqual({
      catalog: "available", mode: "manual", scannedTypeCount: 1, totalTypeCount: 1, complete: true,
    });
  });

  it("preserves owner metadata errors and never guesses that a type is not applicable", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.hasCreatedOwnerField.mockRejectedValue(new MeegleCliError("provider_unauthorized"));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.queryCreatedBaseWorkItems).not.toHaveBeenCalled();
    expect(result.scopes).toEqual(expect.arrayContaining([expect.objectContaining({
      providerItemType: "created:solution-key",
      outcome: "error",
      errorCode: "provider_unauthorized",
    })]));
  });

  it("retries owner metadata after an error instead of caching an unknown capability", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.hasCreatedOwnerField
      .mockRejectedValueOnce(new MeegleCliError("provider_timeout"))
      .mockResolvedValueOnce(true);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    const failed = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    const recovered = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(failed.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerItemType: "created:solution-key", outcome: "error" }),
    ]));
    expect(recovered.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerItemType: "created:solution-key", outcome: "success" }),
    ]));
    expect(client.hasCreatedOwnerField).toHaveBeenCalledTimes(2);
    expect(client.queryCreatedBaseWorkItems).toHaveBeenCalledOnce();
  });

  it("expires owner capabilities with the project and type directory", async () => {
    const client = new FakeClient();
    let currentTime = now.getTime();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    const provider = new MeegleWorkItemProvider({
      client, clock: () => new Date(currentTime),
    });

    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    currentTime += 10 * 60 * 1_000 + 1;
    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.hasCreatedOwnerField).toHaveBeenCalledTimes(2);
    expect(client.listRecentProjects).toHaveBeenCalledTimes(2);
  });

  it("propagates owner metadata cancellation and leaves the automatic batch uncommitted", async () => {
    const client = new FakeClient();
    const types = Array.from({ length: 47 }, (_, index) => ({
      ...createdType, name: `Type ${index}`, type_key: `type-${String(index).padStart(2, "0")}`,
    }));
    const events: CreatedSyncDiagnosticEvent[] = [];
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(types);
    client.hasCreatedOwnerField.mockRejectedValue(new MeegleCliError("provider_cancelled"));
    const provider = new MeegleWorkItemProvider({
      client,
      clock: () => now,
      diagnosticLogger: { completed: (event) => events.push(event) },
    });

    await expect(provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    })).rejects.toMatchObject({ code: "provider_cancelled" });
    expect(events).toEqual([expect.objectContaining({ batchCompleted: false })]);

    client.hasCreatedOwnerField.mockReset();
    client.hasCreatedOwnerField.mockResolvedValue(true);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    await provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    });
    expect(client.queryCreatedBaseWorkItems.mock.calls.map(([, , type]) => type.type_key))
      .toEqual(types.slice(0, 40).map(({ type_key }) => type_key));
  });

  it("keeps owner metadata and created queries inside the four-worker pool", async () => {
    const client = new FakeClient();
    const types = Array.from({ length: 8 }, (_, index) => ({
      ...createdType, name: `Type ${index}`, type_key: `type-${index}`,
    }));
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(types);
    let active = 0;
    let maximumActive = 0;
    const bounded = async <T>(value: T) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    };
    client.hasCreatedOwnerField.mockImplementation(async () => bounded(true));
    client.queryCreatedBaseWorkItems.mockImplementation(async () => bounded(emptyCreatedQuery()));

    await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(maximumActive).toBeGreaterThan(1);
  });

  it("keeps all 132 no-owner types in complete coverage and authoritative inventory", async () => {
    const client = new FakeClient();
    const types = Array.from({ length: 132 }, (_, index) => ({
      ...createdType, name: `Type ${index}`, type_key: `type-${String(index).padStart(3, "0")}`,
    }));
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(types);
    client.hasCreatedOwnerField.mockResolvedValue(false);

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.hasCreatedOwnerField).toHaveBeenCalledTimes(132);
    expect(client.queryCreatedBaseWorkItems).not.toHaveBeenCalled();
    expect(result.createdSyncCoverage).toEqual({
      catalog: "available", mode: "manual", scannedTypeCount: 132, totalTypeCount: 132, complete: true,
    });
    expect(result.authoritativeScopeInventories?.[0]?.providerItemTypes).toHaveLength(132);
    expect(result.scopes.filter(({ providerItemType }) =>
      providerItemType.startsWith("created:") && providerItemType !== "created:catalog"))
      .toHaveLength(132);
  });

  it("excludes disabled types from metadata, queries, coverage, and inventory", async () => {
    const client = new FakeClient();
    const disabled = { ...createdType, is_disable: 1, name: "Disabled", type_key: "disabled" };
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([disabled, createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.hasCreatedOwnerField.mock.calls.map(([, , typeKey]) => typeKey))
      .toEqual(["solution-key"]);
    expect(client.queryCreatedBaseWorkItems.mock.calls.map(([, , type]) => type.type_key))
      .toEqual(["solution-key"]);
    expect(result.createdSyncCoverage).toMatchObject({ scannedTypeCount: 1, totalTypeCount: 1 });
    expect(result.authoritativeScopeInventories).toEqual([expect.objectContaining({
      providerItemTypes: ["created:solution-key"],
    })]);
    expect(result.scopes.some(({ providerItemType }) => providerItemType === "created:disabled"))
      .toBe(false);
  });

  it("completes a manual scan across 110 active types while ignoring 22 disabled types", async () => {
    const client = new FakeClient();
    const active = Array.from({ length: 110 }, (_, index) => ({
      ...createdType, type_key: `active-${String(index).padStart(3, "0")}`,
    }));
    const disabled = Array.from({ length: 22 }, (_, index) => ({
      ...createdType, is_disable: 1, type_key: `disabled-${String(index).padStart(2, "0")}`,
    }));
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([...active, ...disabled]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.hasCreatedOwnerField).toHaveBeenCalledTimes(110);
    expect(client.queryCreatedBaseWorkItems).toHaveBeenCalledTimes(110);
    expect(result.createdSyncCoverage).toEqual({
      catalog: "available", mode: "manual", scannedTypeCount: 110,
      totalTypeCount: 110, complete: true,
    });
  });

  it("accepts more than 200 discovered types when no more than 200 are active", async () => {
    const client = new FakeClient();
    const active = Array.from({ length: 200 }, (_, index) => ({
      ...createdType, type_key: `active-${String(index).padStart(3, "0")}`,
    }));
    const disabled = [{ ...createdType, is_disable: 1, type_key: "disabled" }];
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([...active, ...disabled]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.hasCreatedOwnerField).toHaveBeenCalledTimes(200);
    expect(client.queryCreatedBaseWorkItems.mock.calls.map(([, , type]) => type.type_key))
      .toEqual(active.map(({ type_key }) => type_key));
    expect(result.createdSyncCoverage).toMatchObject({
      catalog: "available", scannedTypeCount: 200, totalTypeCount: 200, complete: true,
    });
  });

  it("rejects a directory with more than 200 active types", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(Array.from({ length: 201 }, (_, index) => ({
      ...createdType, type_key: `active-${String(index).padStart(3, "0")}`,
    })));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.hasCreatedOwnerField).not.toHaveBeenCalled();
    expect(client.queryCreatedBaseWorkItems).not.toHaveBeenCalled();
    expect(result.scopes).toEqual(expect.arrayContaining([expect.objectContaining({
      projectExternalId: "CREATED", providerItemType: "created:catalog", outcome: "error",
    })]));
  });

  it("rotates 110 active types in automatic batches of 40, 40, and 30", async () => {
    const client = new FakeClient();
    const active = Array.from({ length: 110 }, (_, index) => ({
      ...createdType, type_key: `active-${String(index).padStart(3, "0")}`,
    }));
    const disabled = Array.from({ length: 22 }, (_, index) => ({
      ...createdType, is_disable: 1, type_key: `disabled-${String(index).padStart(2, "0")}`,
    }));
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([...active, ...disabled]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    const coverages = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await provider.listAccountWorkItems({
        accountDisplayName: "Example User", refreshMode: "automatic",
      });
      coverages.push(result.createdSyncCoverage);
    }

    expect(coverages.map((coverage) => coverage?.scannedTypeCount)).toEqual([40, 40, 30]);
    expect(coverages.every((coverage) => coverage?.totalTypeCount === 110)).toBe(true);
    expect(client.queryCreatedBaseWorkItems.mock.calls.map(([, , type]) => type.type_key))
      .toEqual(active.map(({ type_key }) => type_key));
    expect(client.hasCreatedOwnerField).toHaveBeenCalledTimes(110);
  });

  it("publishes an authoritative empty inventory for an all-disabled project", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([
      { ...createdType, is_disable: 1, type_key: "disabled" },
    ]);

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.hasCreatedOwnerField).not.toHaveBeenCalled();
    expect(client.queryCreatedBaseWorkItems).not.toHaveBeenCalled();
    expect(result.createdSyncCoverage).toEqual({
      catalog: "available", mode: "manual", scannedTypeCount: 0,
      totalTypeCount: 0, complete: true,
    });
    expect(result.authoritativeScopeInventories).toEqual([{
      projectExternalId: "CREATED", providerItemTypePrefix: "created:", providerItemTypes: [],
    }]);
    expect(result.scopes).toEqual(expect.arrayContaining([expect.objectContaining({
      projectExternalId: "CREATED", providerItemType: "created:catalog", outcome: "success",
    })]));
  });

  it("clears cached created scopes when a project becomes all-disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-disabled-created-"));
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
      const activeClient = new FakeClient();
      activeClient.getMyWorkPage.mockImplementation(pages({}));
      activeClient.listRecentProjects.mockResolvedValue([createdProject]);
      activeClient.listWorkItemTypes.mockResolvedValue([createdType]);
      activeClient.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
      await new WorkItemService(
        new MeegleWorkItemProvider({ client: activeClient, clock: () => now }), () => now, store,
      ).sync(syncInput);

      const disabledClient = new FakeClient();
      disabledClient.getMyWorkPage.mockImplementation(pages({}));
      disabledClient.listRecentProjects.mockResolvedValue([createdProject]);
      disabledClient.listWorkItemTypes.mockResolvedValue([
        { ...createdType, is_disable: 1, type_key: "solution-key" },
      ]);
      const cleared = await new WorkItemService(
        new MeegleWorkItemProvider({ client: disabledClient, clock: () => now }), () => now, store,
      ).sync(syncInput);

      expect(cleared.items).toEqual([]);
      expect(cleared.projects).toEqual([expect.objectContaining({ externalId: "CREATED", count: 0 })]);
      expect(disabledClient.hasCreatedOwnerField).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on an unknown disable state and retries the directory next sync", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes
      .mockResolvedValueOnce([
        { ...createdType, is_disable: 1, type_key: "disabled" },
        { ...createdType, is_disable: 3, type_key: "unknown" },
        createdType,
      ])
      .mockResolvedValueOnce([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    const failed = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    const recovered = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(failed.scopes).toEqual(expect.arrayContaining([expect.objectContaining({
      projectExternalId: "CREATED", providerItemType: "created:catalog", outcome: "error",
    })]));
    expect(recovered.scopes).toEqual(expect.arrayContaining([expect.objectContaining({
      providerItemType: "created:solution-key", outcome: "success",
    })]));
    expect(client.listWorkItemTypes).toHaveBeenCalledTimes(2);
    expect(client.hasCreatedOwnerField).toHaveBeenCalledOnce();
    expect(client.queryCreatedBaseWorkItems).toHaveBeenCalledOnce();
  });

  it("caches only filtered active types and rereads the directory after TTL", async () => {
    const client = new FakeClient();
    let currentTime = now.getTime();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([
      createdType,
      { ...createdType, is_disable: 1, type_key: "disabled" },
    ]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    const provider = new MeegleWorkItemProvider({
      client, clock: () => new Date(currentTime),
    });

    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    currentTime += 10 * 60 * 1_000 + 1;
    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.listWorkItemTypes).toHaveBeenCalledTimes(2);
    expect(client.hasCreatedOwnerField.mock.calls.map(([, , typeKey]) => typeKey))
      .toEqual(["solution-key", "solution-key"]);
    expect(client.queryCreatedBaseWorkItems.mock.calls.every(([, , type]) =>
      type.type_key === "solution-key")).toBe(true);
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
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([{ id: 42 }]));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });
    const matching = result.scopes.flatMap((scope) => scope.items)
      .filter((item) => item.externalId === "42");

    expect(matching).toHaveLength(1);
    expect(client.queryCreatedBaseWorkItems).toHaveBeenCalledOnce();
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
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery(
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
    expect(client.queryCreatedBaseWorkItemsPage).not.toHaveBeenCalled();
  });

  it("accepts an exact 50-row created first page without session pagination", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery(
      Array.from({ length: 50 }, (_, index) => ({ id: index + 1 })),
      { count: 50 },
    ));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items)).toHaveLength(50);
    expect(client.queryCreatedBaseWorkItemsPage).not.toHaveBeenCalled();
  });

  it("maps trusted created completion times and lets the service apply the seven-day window", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([
      { id: 1, statusKey: "completed", statusLabel: "Completed" },
      { id: 2, statusKey: "completed", statusLabel: "Completed" },
      { id: 3, statusKey: "completed", statusLabel: "Completed" },
    ]));
    client.queryCreatedCompletionWorkItems.mockResolvedValue(createdCompletionQuery([
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
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([]));
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
    expect(client.hasCreatedOwnerField).toHaveBeenCalledTimes(2);
  });

  it("does not let an older identity write owner capability into a replacement cache", async () => {
    const client = new FakeClient();
    let currentIdentity = identity;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const releaseFirstPromise = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let metadataCall = 0;
    client.getCurrentUser.mockImplementation(async () => currentIdentity);
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    client.hasCreatedOwnerField.mockImplementation(async () => {
      metadataCall += 1;
      if (metadataCall === 1) {
        firstStarted();
        await releaseFirstPromise;
        return false;
      }
      return true;
    });
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    const first = provider.listAccountWorkItems({ accountDisplayName: "User A" });
    await firstStartedPromise;
    currentIdentity = { ...identity, user_key: "user-b" };
    await provider.listAccountWorkItems({ accountDisplayName: "User B" });
    currentIdentity = identity;
    releaseFirst();
    await first;
    currentIdentity = { ...identity, user_key: "user-b" };
    await provider.listAccountWorkItems({ accountDisplayName: "User B" });

    expect(client.hasCreatedOwnerField).toHaveBeenCalledTimes(2);
    expect(client.queryCreatedBaseWorkItems).toHaveBeenCalledTimes(2);
  });

  it("isolates a created type failure while preserving mywork and successful created types", async () => {
    const client = new FakeClient();
    const failedType = { ...createdType, name: "Broken", type_key: "broken" };
    client.getMyWorkPage.mockImplementation(pages({
      todo: [{ list: [rawItem(9)], total: 1 }],
    }));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType, failedType]);
    client.queryCreatedBaseWorkItems.mockImplementation(async (_profile, _project, type) => {
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
    client.queryCreatedBaseWorkItems.mockImplementation(async () => {
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
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([]));
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });
    await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.listRecentProjects).toHaveBeenCalledTimes(1);
    expect(client.listWorkItemTypes).toHaveBeenCalledTimes(1);
    expect(client.hasCreatedOwnerField).toHaveBeenCalledTimes(1);
    expect(client.queryCreatedBaseWorkItems).toHaveBeenCalledTimes(2);
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
    expect(client.queryCreatedBaseWorkItems).not.toHaveBeenCalled();
  });

  it("rejects a created type reporting more than 10000 items without losing mywork", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      todo: [{ list: [rawItem(9)], total: 1 }],
    }));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([], { count: 10_001 }));

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
    expect(client.queryCreatedBaseWorkItemsPage).not.toHaveBeenCalled();
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
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
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
      firstClient.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
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
      firstClient.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
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
      firstClient.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
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
      createdClient.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
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
      myworkClient.queryCreatedBaseWorkItems.mockRejectedValue(
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
      createdClient.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([{
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
      createdClient.queryCreatedBaseWorkItems.mockResolvedValue(createdQuery([{ id: 7001 }]));
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
      nodesClient.queryCreatedBaseWorkItems.mockRejectedValue(
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

  it("caps automatic created base queries at forty without emitting errors for deferred types", async () => {
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
    client.queryCreatedBaseWorkItems.mockImplementation(async (_profile, project, type) => {
      if (type.type_key.endsWith("00")) throw new MeegleCliError("provider_unavailable");
      return createdQuery([]);
    });

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User", refreshMode: "automatic" });

    expect(client.queryCreatedBaseWorkItems).toHaveBeenCalledTimes(40);
    expect(client.queryCreatedBaseWorkItems.mock.calls.every(([, project]) =>
      project.project_key !== "P3")).toBe(true);
    expect(result.scopes.some((scope) => scope.projectExternalId === "P3"
      && scope.providerItemType.startsWith("created:")
      && scope.providerItemType !== "created:catalog")).toBe(false);
    expect(result.createdSyncCoverage).toEqual({
      catalog: "available",
      mode: "automatic",
      scannedTypeCount: 40,
      totalTypeCount: 60,
      complete: false,
    });
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

  it("defaults to a complete manual scan and publishes the full stable type inventory", async () => {
    const client = new FakeClient();
    const types = Array.from({ length: 132 }, (_, index) => ({
      ...createdType,
      name: `Type ${index}`,
      type_key: `type-${String(index).padStart(3, "0")}`,
    }));
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(types);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.queryCreatedBaseWorkItems).toHaveBeenCalledTimes(types.length);
    expect(result.createdSyncCoverage).toEqual({
      catalog: "available",
      mode: "manual",
      scannedTypeCount: types.length,
      totalTypeCount: types.length,
      complete: true,
    });
    expect(result.authoritativeScopeInventories).toEqual([{
      projectExternalId: "CREATED",
      providerItemTypePrefix: "created:",
      providerItemTypes: types.map(({ type_key }) => `created:${type_key}`),
    }]);
  });

  it("publishes unique inventories in stable project and type order", async () => {
    const client = new FakeClient();
    const projectA = { ...createdProject, project_key: "A", name: "Project A" };
    const projectB = { ...createdProject, project_key: "B", name: "Project B" };
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([projectB, projectA]);
    client.listWorkItemTypes.mockResolvedValue([
      { ...createdType, type_key: "z-type" },
      { ...createdType, type_key: "a-type" },
      { ...createdType, type_key: "a-type" },
    ]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.authoritativeScopeInventories).toEqual([
      {
        projectExternalId: "A",
        providerItemTypePrefix: "created:",
        providerItemTypes: ["created:a-type", "created:z-type"],
      },
      {
        projectExternalId: "B",
        providerItemTypePrefix: "created:",
        providerItemTypes: ["created:a-type", "created:z-type"],
      },
    ]);
    expect(result.createdSyncCoverage).toMatchObject({
      scannedTypeCount: 4,
      totalTypeCount: 4,
    });
  });

  it("rotates a single 47-type project across automatic refreshes", async () => {
    const client = new FakeClient();
    const types = Array.from({ length: 47 }, (_, index) => ({
      ...createdType,
      name: `Type ${index}`,
      type_key: `type-${String(index).padStart(2, "0")}`,
    }));
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(types);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    const first = await provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    });
    const firstKeys = client.queryCreatedBaseWorkItems.mock.calls.map(([, , type]) => type.type_key);
    client.queryCreatedBaseWorkItems.mockClear();
    const second = await provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    });
    const secondKeys = client.queryCreatedBaseWorkItems.mock.calls.map(([, , type]) => type.type_key);

    expect(firstKeys).toHaveLength(40);
    expect(secondKeys).toEqual(types.slice(40).map(({ type_key }) => type_key));
    expect(new Set([...firstKeys, ...secondKeys])).toEqual(new Set(types.map(({ type_key }) => type_key)));
    expect(first.createdSyncCoverage).toMatchObject({ scannedTypeCount: 40, complete: false });
    expect(second.createdSyncCoverage).toMatchObject({ scannedTypeCount: 7, complete: false });
  });

  it("skips completion enrichment for active-only base rows", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdBaseQuery([{ id: 7 }]));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.queryCreatedCompletionWorkItems).not.toHaveBeenCalled();
    expect(result.scopes.flatMap(({ items }) => items)).toEqual([
      expect.objectContaining({ externalId: "7", stage: "in_progress" }),
    ]);
  });

  it("joins completion enrichment by exact work item ID and calls it once per type", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdBaseQuery([
      { id: 7 },
      { id: 8, statusKey: "completed", statusLabel: "Completed" },
    ]));
    client.queryCreatedCompletionWorkItems.mockResolvedValue(createdCompletionQuery([
      { id: 8, statusKey: "completed", statusLabel: "Completed", finishTime: "2026-08-10T00:00:00Z" },
      { id: 7 },
    ]));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.queryCreatedCompletionWorkItems).toHaveBeenCalledOnce();
    expect(result.scopes.flatMap(({ items }) => items)
      .map((item) => [item.externalId, item.completedAt, item.stage]))
      .toEqual([
        ["7", undefined, "in_progress"],
        ["8", "2026-08-10T00:00:00.000Z", "done"],
      ]);
  });

  it("keeps active rows and does not create an error scope when completion enrichment fails", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdBaseQuery([
      { id: 7 },
      { id: 8, statusKey: "completed", statusLabel: "Completed" },
    ]));
    client.queryCreatedCompletionWorkItems.mockRejectedValue(new MeegleCliError("provider_unavailable"));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });
    const createdScope = result.scopes.find(({ providerItemType }) =>
      providerItemType === "created:solution-key");

    expect(createdScope).toMatchObject({ outcome: "success" });
    expect(createdScope?.items.map(({ externalId }) => externalId)).toEqual(["7"]);
  });

  it.each([
    "missing-field",
    "invalid-response",
    "duplicate-id",
    "mismatched-id",
    "invalid-date",
    "over-50",
  ] as const)("keeps active rows when completion enrichment has %s", async (failure) => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue([createdType]);
    client.queryCreatedBaseWorkItems.mockResolvedValue(createdBaseQuery([
      { id: 7 },
      { id: 8, statusKey: "completed", statusLabel: "Completed" },
    ]));
    let response: unknown;
    if (failure === "invalid-response") {
      response = undefined;
    } else if (failure === "over-50") {
      response = createdCompletionQuery(Array.from({ length: 51 }, (_, index) => ({ id: index })));
    } else {
      response = createdCompletionQuery([
        { id: 7 },
        {
          id: failure === "duplicate-id" ? 7 : failure === "mismatched-id" ? 9 : 8,
          statusKey: "completed",
          statusLabel: "Completed",
          finishTime: failure === "invalid-date" ? "not-a-date" : "2026-08-10T00:00:00Z",
        },
      ]);
      if (failure === "missing-field") {
        const rows = (response as MeegleCreatedCompletionQuery & {
          data: { "1": Array<{ moql_field_list: unknown[] }> };
        }).data["1"];
        rows[1]?.moql_field_list.pop();
      }
    }
    client.queryCreatedCompletionWorkItems.mockResolvedValue(
      response as MeegleCreatedCompletionQuery,
    );

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });
    const scope = result.scopes.find(({ providerItemType }) =>
      providerItemType === "created:solution-key");

    expect(scope).toMatchObject({ outcome: "success" });
    expect(scope?.items.map(({ externalId }) => externalId)).toEqual(["7"]);
  });

  it("shares one four-call concurrency pool across base and completion queries", async () => {
    const client = new FakeClient();
    const types = Array.from({ length: 8 }, (_, index) => ({
      ...createdType, name: `Type ${index}`, type_key: `type-${index}`,
    }));
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(types);
    let active = 0;
    let maximumActive = 0;
    const track = async <T>(value: T) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    };
    client.queryCreatedBaseWorkItems.mockImplementation(async (_profile, _project, type) =>
      track(createdBaseQuery([{ id: Number(type.type_key.slice(5)), statusKey: "done", statusLabel: "Done" }])));
    client.queryCreatedCompletionWorkItems.mockImplementation(async (_profile, _project, type) =>
      track(createdCompletionQuery([{
        id: Number(type.type_key.slice(5)), statusKey: "done", statusLabel: "Done",
        finishTime: "2026-08-10T00:00:00Z",
      }])));

    await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(client.queryCreatedCompletionWorkItems).toHaveBeenCalledTimes(types.length);
  });

  it("reports partial and unavailable catalogs without publishing failed inventories", async () => {
    const partialClient = new FakeClient();
    const failedProject = { ...createdProject, project_key: "FAILED", name: "Failed" };
    partialClient.getMyWorkPage.mockImplementation(pages({}));
    partialClient.listRecentProjects.mockResolvedValue([createdProject, failedProject]);
    partialClient.listWorkItemTypes.mockImplementation(async (_profile, projectKey) => {
      if (projectKey === "FAILED") throw new MeegleCliError("provider_unavailable");
      return [];
    });
    const partial = await new MeegleWorkItemProvider({ client: partialClient, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(partial.createdSyncCoverage).toEqual({
      catalog: "partial", mode: "manual", scannedTypeCount: 0,
      knownTypeCount: 0, failedProjectCount: 1, complete: false,
    });
    expect(partial.authoritativeScopeInventories).toEqual([{
      projectExternalId: "CREATED", providerItemTypePrefix: "created:", providerItemTypes: [],
    }]);

    const unavailableClient = new FakeClient();
    unavailableClient.getMyWorkPage.mockImplementation(pages({}));
    unavailableClient.listRecentProjects.mockRejectedValue(new MeegleCliError("provider_unavailable"));
    const unavailable = await new MeegleWorkItemProvider({
      client: unavailableClient, clock: () => now,
    }).listAccountWorkItems({ accountDisplayName: "Example User", refreshMode: "automatic" });
    expect(unavailable.createdSyncCoverage).toEqual({
      catalog: "unavailable", mode: "automatic", scannedTypeCount: 0, complete: false,
    });
    expect(unavailable.authoritativeScopeInventories).toBeUndefined();
  });

  it("publishes an authoritative empty inventory for an available empty project catalog", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([]);

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.createdSyncCoverage).toEqual({
      catalog: "available",
      mode: "manual",
      scannedTypeCount: 0,
      totalTypeCount: 0,
      complete: true,
    });
    expect(result.authoritativeScopeInventories).toEqual([]);
  });

  it("logs exactly once and leaves the automatic cursor uncommitted on identity mismatch", async () => {
    const client = new FakeClient();
    const types = Array.from({ length: 47 }, (_, index) => ({
      ...createdType, name: `Type ${index}`, type_key: `type-${String(index).padStart(2, "0")}`,
    }));
    const events: CreatedSyncDiagnosticEvent[] = [];
    const diagnosticLogger: CreatedSyncDiagnosticLogger = {
      completed: (event) => events.push(event),
    };
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(types);
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    client.getCurrentUser
      .mockResolvedValue(identity)
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce({ ...identity, user_key: "changed" });
    const provider = new MeegleWorkItemProvider({
      client, clock: () => now, diagnosticLogger,
    });

    await expect(provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    })).rejects.toMatchObject({ code: "provider_unauthorized" });
    const rejectedKeys = client.queryCreatedBaseWorkItems.mock.calls
      .map(([, , type]) => type.type_key);
    client.queryCreatedBaseWorkItems.mockClear();

    await provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    });
    const retriedKeys = client.queryCreatedBaseWorkItems.mock.calls
      .map(([, , type]) => type.type_key);
    client.queryCreatedBaseWorkItems.mockClear();
    await provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    });

    expect(retriedKeys).toEqual(rejectedKeys);
    expect(client.queryCreatedBaseWorkItems.mock.calls.map(([, , type]) => type.type_key))
      .toEqual(types.slice(40).map(({ type_key }) => type_key));
    expect(events).toHaveLength(3);
    expect(events.map(({ batchCompleted }) => batchCompleted)).toEqual([false, true, true]);
    expect(events[0]?.attemptedIdentityHashes).toHaveLength(40);
    expect(events[0]?.attemptedIdentityHashes.every((hash) => /^[0-9a-f]{16}$/u.test(hash)))
      .toBe(true);
  });

  it("propagates automatic base cancellation, logs false once, and retries the first batch", async () => {
    const client = new FakeClient();
    const types = Array.from({ length: 47 }, (_, index) => ({
      ...createdType, name: `Type ${index}`, type_key: `type-${String(index).padStart(2, "0")}`,
    }));
    const events: CreatedSyncDiagnosticEvent[] = [];
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(types);
    client.queryCreatedBaseWorkItems.mockRejectedValue(new MeegleCliError("provider_cancelled"));
    const provider = new MeegleWorkItemProvider({
      client,
      clock: () => now,
      diagnosticLogger: {
        completed(event) {
          events.push(event);
          throw new Error("logger failed");
        },
      },
    });

    await expect(provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    })).rejects.toMatchObject({ code: "provider_cancelled" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ batchCompleted: false, mode: "automatic" });
    expect(events[0]?.attemptedIdentityHashes.length).toBeGreaterThan(0);
    expect(events[0]?.attemptedIdentityHashes.length).toBeLessThanOrEqual(4);
    expect(events[0]?.scannedTypeCount).toBe(events[0]?.attemptedIdentityHashes.length);

    client.queryCreatedBaseWorkItems.mockReset();
    client.queryCreatedBaseWorkItems.mockResolvedValue(emptyCreatedQuery());
    await provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    });
    expect(client.queryCreatedBaseWorkItems.mock.calls.map(([, , type]) => type.type_key))
      .toEqual(types.slice(0, 40).map(({ type_key }) => type_key));
    expect(events.map(({ batchCompleted }) => batchCompleted)).toEqual([false, true]);
  });

  it("propagates completion cancellation and leaves the automatic cursor at the first batch", async () => {
    const client = new FakeClient();
    const types = Array.from({ length: 47 }, (_, index) => ({
      ...createdType, name: `Type ${index}`, type_key: `type-${String(index).padStart(2, "0")}`,
    }));
    const events: CreatedSyncDiagnosticEvent[] = [];
    let cancelCompletion = true;
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([createdProject]);
    client.listWorkItemTypes.mockResolvedValue(types);
    client.queryCreatedBaseWorkItems.mockImplementation(async () => cancelCompletion
      ? createdBaseQuery([{ id: 1, statusKey: "completed", statusLabel: "Completed" }])
      : emptyCreatedQuery());
    client.queryCreatedCompletionWorkItems.mockRejectedValue(
      new MeegleCliError("provider_cancelled"),
    );
    const provider = new MeegleWorkItemProvider({
      client,
      clock: () => now,
      diagnosticLogger: { completed: (event) => events.push(event) },
    });

    await expect(provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    })).rejects.toMatchObject({ code: "provider_cancelled" });
    expect(events).toHaveLength(1);
    expect(events[0]?.batchCompleted).toBe(false);
    expect(events[0]?.attemptedIdentityHashes.length).toBeGreaterThan(0);
    expect(events[0]?.attemptedIdentityHashes.length).toBeLessThanOrEqual(4);
    expect(events[0]?.scannedTypeCount).toBe(events[0]?.attemptedIdentityHashes.length);

    cancelCompletion = false;
    client.queryCreatedBaseWorkItems.mockClear();
    await provider.listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    });
    expect(client.queryCreatedBaseWorkItems.mock.calls.map(([, , type]) => type.type_key))
      .toEqual(types.slice(0, 40).map(({ type_key }) => type_key));
    expect(events.map(({ batchCompleted }) => batchCompleted)).toEqual([false, true]);
  });

  it.each(["project-catalog", "type-metadata"] as const)(
    "propagates created %s cancellation instead of reporting an available or partial batch",
    async (path) => {
      const client = new FakeClient();
      const events: CreatedSyncDiagnosticEvent[] = [];
      client.getMyWorkPage.mockImplementation(pages({}));
      if (path === "project-catalog") {
        client.listRecentProjects.mockRejectedValue(new MeegleCliError("provider_cancelled"));
      } else {
        client.listRecentProjects.mockResolvedValue([createdProject]);
        client.listWorkItemTypes.mockRejectedValue(new MeegleCliError("provider_cancelled"));
      }

      await expect(new MeegleWorkItemProvider({
        client,
        clock: () => now,
        diagnosticLogger: { completed: (event) => events.push(event) },
      })
        .listAccountWorkItems({ accountDisplayName: "Example User", refreshMode: "automatic" }))
        .rejects.toMatchObject({ code: "provider_cancelled" });
      expect(client.queryCreatedBaseWorkItems).not.toHaveBeenCalled();
      expect(events).toEqual([expect.objectContaining({
        mode: "automatic",
        catalog: "unavailable",
        totalTypeCount: 0,
        scannedTypeCount: 0,
        attemptedIdentityHashes: [],
        batchCompleted: false,
      })]);
    },
  );

  it("logs partial directory coverage when metadata cancellation follows a successful directory", async () => {
    const client = new FakeClient();
    const events: CreatedSyncDiagnosticEvent[] = [];
    const projectA = { ...createdProject, project_key: "A", name: "Project A" };
    const projectB = { ...createdProject, project_key: "B", name: "Project B" };
    const knownTypes = [
      { ...createdType, type_key: "known-a", name: "Known A" },
      { ...createdType, type_key: "known-b", name: "Known B" },
    ];
    client.getMyWorkPage.mockImplementation(pages({}));
    client.listRecentProjects.mockResolvedValue([projectA, projectB]);
    client.listWorkItemTypes.mockImplementation(async (_profile, projectKey) => {
      if (projectKey === "A") return knownTypes;
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw new MeegleCliError("provider_cancelled");
    });

    await expect(new MeegleWorkItemProvider({
      client,
      clock: () => now,
      diagnosticLogger: { completed: (event) => events.push(event) },
    }).listAccountWorkItems({
      accountDisplayName: "Example User", refreshMode: "automatic",
    })).rejects.toMatchObject({ code: "provider_cancelled" });

    expect(client.queryCreatedBaseWorkItems).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({
      mode: "automatic",
      catalog: "partial",
      totalTypeCount: knownTypes.length,
      scannedTypeCount: 0,
      attemptedIdentityHashes: [],
      batchCompleted: false,
    })]);
  });

  it.each(["Incomplete", "Not Completed"])(
    "keeps non-terminal created status %s active without completion enrichment",
    async (status) => {
      const client = new FakeClient();
      client.getMyWorkPage.mockImplementation(pages({}));
      client.listRecentProjects.mockResolvedValue([createdProject]);
      client.listWorkItemTypes.mockResolvedValue([createdType]);
      client.queryCreatedBaseWorkItems.mockResolvedValue(createdBaseQuery([{
        id: 7, statusKey: status, statusLabel: status,
      }]));
      client.queryCreatedCompletionWorkItems.mockRejectedValue(
        new MeegleCliError("provider_unavailable"),
      );

      const result = await new MeegleWorkItemProvider({ client, clock: () => now })
        .listAccountWorkItems({ accountDisplayName: "Example User" });
      const item = result.scopes.flatMap(({ items }) => items)[0];

      expect(client.queryCreatedCompletionWorkItems).not.toHaveBeenCalled();
      expect(item).toMatchObject({ externalId: "7" });
      expect(item?.stage).not.toBe("done");
    },
  );
});
