import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TapdAuthenticator } from "../src/auth/tapd-auth-service.js";
import { TapdIdentityError } from "../src/auth/tapd-identity-client.js";
import { WorkItemCacheError } from "../src/cache/work-item-cache-store.js";
import type { ProjectCatalogResult } from "../src/contracts/projects.js";
import type { TaskboardPreferences } from "../src/contracts/taskboard-preferences.js";
import type { WorkItemDetail } from "../src/contracts/work-item-detail.js";
import type { ProjectOperationLogger } from "../src/observability/project-operation-logger.js";
import type { TaskboardPreferencesOperationLogger } from "../src/observability/taskboard-preferences-operation-logger.js";
import type { WorkItemDetailOperationLogger } from "../src/observability/work-item-detail-operation-logger.js";
import type { WorkItemOperationLogger } from "../src/observability/work-item-operation-logger.js";
import type { ProjectCatalog } from "../src/projects/project-catalog-service.js";
import { TaskboardPreferencesStoreError } from "../src/preferences/taskboard-preferences-store.js";
import {
  createTaskboardMcpServer,
  taskboardResourceUri,
} from "../src/server/app.js";
import {
  assertLoopbackHost,
  createTaskboardHttpServer,
} from "../src/server/http.js";
import type { WorkItemDetailReader } from "../src/work-items/work-item-detail-service.js";
import { WorkItemDetailProviderError } from "../src/work-items/work-item-detail-provider.js";
import type { WorkItemSynchronizer } from "../src/work-items/work-item-service.js";
import { ProviderRegistry } from "../src/providers/provider-registry.js";
import type { ActiveProviderStore } from "../src/providers/active-provider-store.js";
import type { ProviderConnection } from "../src/contracts/providers.js";
import type { RuntimeServices } from "../src/server/runtime-services.js";
import { ProviderLoginCoordinator } from "../src/providers/provider-login-coordinator.js";
import type { ProviderLoginDriver } from "../src/providers/provider-login-driver.js";
import { InMemoryExecutionStore } from "../src/executions/execution-store.js";
import { ExecutionService } from "../src/executions/execution-service.js";

const temporaryDirectories: string[] = [];
const TEST_RUNTIME_VERSION = {
  version: "0.2.1",
  protocolVersion: 1,
  uiVersion: "0.2.1",
} as const;
const TEST_TASKBOARD_RESOURCE_URI = "ui://flowrivet/taskboard/0.2.1.html";

describe("runtime version tool", () => {
  it("returns the version contract without process identity", async () => {
    const connection = await connectClient(await createBundle());
    try {
      const result = await connection.client.callTool({ name: "get_runtime_version", arguments: {} });
      expect(result.structuredContent).toEqual(TEST_RUNTIME_VERSION);
      expect(result.structuredContent).not.toHaveProperty("pid");
      expect(result.structuredContent).not.toHaveProperty("instanceId");
    } finally {
      await connection.close();
    }
  });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createBundle(contents = "<html><body>FlowRivet</body></html>") {
  const directory = await mkdtemp(join(tmpdir(), "flowrivet-mcp-"));
  temporaryDirectories.push(directory);
  const bundlePath = join(directory, "taskboard.html");
  await writeFile(bundlePath, contents, "utf8");
  return bundlePath;
}

function authenticator(
  tapd: "connected" | "disconnected" | "expired" = "connected",
): TapdAuthenticator {
  const connection = tapd === "connected"
    ? { tapd, userName: "吴晨杰", companyName: "FlowRivet 演示企业" } as const
    : { tapd } as const;
  const identity = {
    userName: "吴晨杰",
    accountKey: "6081",
    companyName: "FlowRivet 演示企业",
    companyId: "66238498",
  };
  const connectedResult = { ok: true as const, connection };
  return {
    login: async () => ({ ok: true, connection: {
      tapd: "connected",
      userName: "吴晨杰",
      companyName: "FlowRivet 测试企业",
    } }),
    getConnectionStatus: async () => ({ ok: true, connection }),
    disconnect: async () => ({ ok: true, connection: { tapd: "disconnected" } }),
    validateCandidate: async () => identity,
    commitCandidate: async () => ({ ok: true, connection: {
      tapd: "connected",
      userName: identity.userName,
      companyName: identity.companyName,
    } }),
    getSession: async () => tapd === "connected"
      ? { result: connectedResult, identity }
      : { result: connectedResult },
  };
}

async function connectClient(
  uiBundlePath: string,
  authService: TapdAuthenticator = authenticator(),
  projectCatalog: ProjectCatalog = catalog().service,
  projectLogger?: ProjectOperationLogger,
  workItemService: WorkItemSynchronizer = synchronizer().service,
  workItemLogger?: WorkItemOperationLogger,
  workItemDetailService: WorkItemDetailReader = detailReader().service,
  workItemDetailLogger?: WorkItemDetailOperationLogger,
  taskboardPreferences?: {
    get(): Promise<TaskboardPreferences>;
    save(preferences: TaskboardPreferences): Promise<TaskboardPreferences>;
  },
  taskboardPreferencesLogger?: TaskboardPreferencesOperationLogger,
) {
  const server = createTaskboardMcpServer({
    uiBundlePath,
    runtimeVersion: TEST_RUNTIME_VERSION,
    authService,
    projectCatalog,
    ...(projectLogger ? { projectLogger } : {}),
    workItemService,
    ...(workItemLogger ? { workItemLogger } : {}),
    workItemDetailService,
    ...(workItemDetailLogger ? { workItemDetailLogger } : {}),
    ...(taskboardPreferences ? { taskboardPreferences } : {}),
    ...(taskboardPreferencesLogger ? { taskboardPreferencesLogger } : {}),
  });
  const client = new Client({ name: "flowrivet-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function catalog(projects: ProjectCatalogResult["projects"] = []) {
  const result: ProjectCatalogResult = {
    provider: {
      providerId: "tapd",
      displayName: "TAPD",
      state: "connected",
      accountDisplayName: "吴晨杰",
    },
    projects,
    stale: false,
  };
  const service: ProjectCatalog = {
    getCatalog: vi.fn().mockResolvedValue(result),
    discover: vi.fn().mockResolvedValue(result),
    saveSelection: vi.fn().mockResolvedValue(result),
    addProject: vi.fn().mockResolvedValue(result),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  return { result, service };
}

function project(externalId: string, selected = true) {
  return {
    providerId: "tapd",
    externalId,
    name: `Project ${externalId}`,
    selected,
    available: true,
    source: "discovered" as const,
    lastVerifiedAt: "2026-08-07T00:00:00.000Z",
  };
}

function synchronizer(
  projects: ProjectCatalogResult["projects"] = [],
  providerId = "tapd",
) {
  const items = projects.map((entry, index) => ({
    key: `${providerId}:${entry.externalId}:task:${index + 1}`,
    providerId,
    externalId: String(index + 1),
    projectExternalId: entry.externalId,
    projectName: entry.name,
    kind: "task" as const,
    providerItemType: "task",
    title: `Work ${index + 1}`,
    stage: "todo" as const,
    providerStatus: "open",
    freshness: "fresh" as const,
    externalUrl: `https://example.test/work/${index + 1}`,
  }));
  const result = {
    items,
    projects: projects.map((entry) => ({ ...entry, count: 1 })),
    summary: {
      successfulProjects: projects.length,
      failedProjects: 0,
      itemCount: items.length,
    },
    dataFreshness: "live" as const,
    freshScopeCount: projects.length * 3,
    staleScopeCount: 0,
    lastSuccessfulSyncAt: "2026-08-07T00:00:00.000Z",
    lastSyncAttemptAt: "2026-08-07T00:00:00.000Z",
  };
  const service: WorkItemSynchronizer = {
    sync: vi.fn().mockResolvedValue(result),
    loadCached: vi.fn().mockResolvedValue(undefined),
    clearCached: vi.fn().mockResolvedValue(undefined),
  };
  return { result, service };
}

function detailReader(overrides: Partial<WorkItemDetail> = {}) {
  const result: WorkItemDetail = {
    key: "tapd:50396062:requirement:10001",
    providerId: "tapd",
    projectExternalId: "50396062",
    providerItemType: "story",
    externalId: "10001",
    projectName: "Project 50396062",
    kind: "requirement",
    title: "Sensitive detail title",
    providerStatus: "planning",
    assignees: ["吴晨杰"],
    sanitizedDescriptionHtml: "<p>Sensitive description</p>",
    descriptionTruncated: false,
    externalUrl: "https://www.tapd.cn/50396062/prong/stories/view/10001",
    ...overrides,
  };
  const service: WorkItemDetailReader = { get: vi.fn().mockResolvedValue(result) };
  return { result, service };
}

describe("taskboard MCP app", () => {
  it("exposes provider-neutral tools and opens an account-scoped Feishu board", async () => {
    let connectionState: ProviderConnection["state"] = "connected";
    const providerConnection: ProviderConnection = {
      providerId: "feishu-project",
      displayName: "飞书项目",
      state: "connected",
      accountDisplayName: "Example User",
      profileName: "default",
    };
    const auth = {
      getConnection: vi.fn(async () => ({ ...providerConnection, state: connectionState })),
      getSessionIdentity: vi.fn(() => ({
        profileName: "default",
        accountKey: "user_example",
        accountDisplayName: "Example User",
      })),
      disconnect: vi.fn(async () => ({ ...providerConnection, state: "disconnected" as const })),
    };
    const login: ProviderLoginDriver = {
      allowedBrowserHosts: ["open.feishu.cn"],
      captureProfile: vi.fn(async () => "default"),
      initialize: vi.fn(async () => ({
        attempt: { internal: true },
        verificationUri: "https://open.feishu.cn/device",
        verificationUriComplete: "https://open.feishu.cn/device?code=example",
        userCode: "USER-CODE",
        expiresAt: "2026-08-11T00:05:00.000Z",
        intervalMs: 5_000,
      })),
      poll: vi.fn(async () => ({ state: "pending" })),
      verifyIdentity: vi.fn(async () => ({
        profileName: "default",
        accountKey: "user_example",
        accountDisplayName: "Example User",
      })),
      dispose: vi.fn(async () => undefined),
    };
    const workItems = {
      id: "feishu-project",
      queryMode: "account_scoped" as const,
      listAccountWorkItems: vi.fn(),
    };
    const registry = new ProviderRegistry([{
      id: "feishu-project",
      displayName: "飞书项目",
      loginMode: "device_code",
      auth,
      login,
      workItems,
    }]);
    const loginCoordinator = new ProviderLoginCoordinator({
      resolveDriver: (providerId) => registry.get(providerId).login,
      browserLauncher: { open: vi.fn(async () => "opened") },
      logger: { log: vi.fn() },
      clock: () => new Date("2026-08-11T00:00:00.000Z"),
      sessionId: () => "session-example",
      correlationId: () => "correlation-example",
    });
    const activeProviderStore: ActiveProviderStore = {
      load: vi.fn(async () => ({ version: 1, activeProviderId: "feishu-project" })),
      save: vi.fn(async () => undefined),
    };
    const synced = synchronizer([{
      providerId: "feishu-project",
      externalId: "PROJ",
      name: "Example Project",
      selected: true,
      available: true,
      source: "discovered",
      lastVerifiedAt: "2026-08-11T00:00:00.000Z",
    }], "feishu-project");
    vi.mocked(synced.service.loadCached).mockResolvedValue(synced.result);
    const notification = {
      id: "notification-1",
      providerId: "feishu-project",
      workItemKey: "feishu-project:PROJ:task:1",
      type: "assigned" as const,
      title: "Work 1",
      projectName: "Example Project",
      message: "已分配给你",
      occurredAt: "2026-08-11T00:00:00.000Z",
      externalUrl: "https://project.feishu.cn/space/story/detail/1",
    };
    let notifications = [notification];
    const notificationStore = {
      loadBaseline: vi.fn(),
      applyScan: vi.fn(),
      list: vi.fn(async (_account, options: { unreadOnly?: boolean }) => ({
        notifications: options.unreadOnly
          ? notifications.filter((entry) => !("readAt" in entry))
          : notifications,
        unreadCount: notifications.filter((entry) => !("readAt" in entry)).length,
      })),
      markRead: vi.fn(async (_account, id: string, date: Date) => {
        notifications = notifications.map((entry) => entry.id === id
          ? { ...entry, readAt: date.toISOString() }
          : entry) as typeof notifications;
      }),
      markAllRead: vi.fn(async (_account, date: Date) => {
        notifications = notifications.map((entry) => ({
          ...entry,
          readAt: date.toISOString(),
        })) as typeof notifications;
      }),
    };
    const runtimeServices = {
      registry,
      loginCoordinator,
      activeProviderStore,
      workItemServices: new Map([["feishu-project", synced.service]]),
      notificationStore,
      notificationMonitor: { start: vi.fn(), stop: vi.fn() },
      gitLabService: {
        getConnection: vi.fn().mockResolvedValue({
          host: "gitlab-aiabu.ruijie.com.cn",
          state: "connected",
          cliVersion: "1.113.0",
          accountDisplayName: "wuchenjie",
        }),
        startLogin: vi.fn().mockResolvedValue({ state: "connected" }),
        listProjects: vi.fn().mockResolvedValue({
          page: 1,
          hasMore: false,
          projects: [{
            host: "gitlab-aiabu.ruijie.com.cn",
            projectId: "1",
            pathWithNamespace: "cc/flowrivet",
            displayName: "flowrivet",
            defaultBranch: "main",
            httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git",
          }],
        }),
      },
      executionService: new ExecutionService({
        store: new InMemoryExecutionStore(),
        clock: () => new Date("2026-08-12T00:00:00.000Z"),
        createId: () => "execution-example",
      }),
    } as RuntimeServices;
    const server = createTaskboardMcpServer({
      uiBundlePath: await createBundle(),
      runtimeServices,
    });
    const client = new Client({ name: "flowrivet-provider-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "list_providers",
        "get_active_provider",
        "set_active_provider",
        "get_provider_connection",
        "start_provider_login",
        "get_provider_login",
        "reopen_provider_login",
        "cancel_provider_login",
        "disconnect_provider",
        "list_work_item_notifications",
        "mark_work_item_notification_read",
        "mark_all_work_item_notifications_read",
        "get_gitlab_connection",
        "start_gitlab_login",
        "recheck_gitlab_connection",
        "list_gitlab_projects",
        "prepare_work_item_execution",
      ]));
      expect(names).not.toEqual(expect.arrayContaining([
        "get_connection_status",
        "login_with_tapd_token",
        "disconnect_tapd",
      ]));

      await expect(client.callTool({ name: "get_gitlab_connection", arguments: {} }))
        .resolves.toMatchObject({ structuredContent: { state: "connected" } });
      await expect(client.callTool({ name: "start_gitlab_login", arguments: {} }))
        .resolves.toMatchObject({ structuredContent: { state: "connected" } });
      await expect(client.callTool({ name: "list_gitlab_projects", arguments: { page: 1, perPage: 50 } }))
        .resolves.toMatchObject({ structuredContent: { projects: [{ pathWithNamespace: "cc/flowrivet" }] } });

      const board = await client.callTool({ name: "open_my_taskboard", arguments: {} });
      expect(board.structuredContent).toMatchObject({
        connection: { provider: { providerId: "feishu-project", state: "connected" } },
        projects: [expect.objectContaining({ externalId: "PROJ" })],
        items: [expect.objectContaining({ providerId: "feishu-project" })],
      });
      const boardItem = (board.structuredContent as { items: unknown[] }).items[0];
      const firstExecution = await client.callTool({
        name: "prepare_work_item_execution", arguments: { item: boardItem },
      });
      const resumedExecution = await client.callTool({
        name: "prepare_work_item_execution", arguments: { item: boardItem },
      });
      expect(firstExecution.structuredContent).toMatchObject({
        execution: { executionId: "execution-example", accountKey: "user_example" },
        handoff: { handoffId: "flowrivet-execution-example" },
      });
      expect(resumedExecution.structuredContent).toMatchObject({
        execution: { executionId: "execution-example" },
      });
      expect(synced.service.sync).toHaveBeenCalledWith({
        accountDisplayName: "Example User",
        projects: [],
        syncSessionKey: "default",
        cacheAccount: {
          providerId: "feishu-project",
          accountKey: "user_example",
          accountDisplayName: "Example User",
        },
      });

      connectionState = "disconnected";
      const cachedBoard = await client.callTool({ name: "open_my_taskboard", arguments: {} });
      expect(cachedBoard.structuredContent).toMatchObject({
        connection: { provider: { providerId: "feishu-project", state: "disconnected" } },
        projects: [expect.objectContaining({ externalId: "PROJ" })],
      });
      expect(synced.service.sync).toHaveBeenCalledOnce();
      expect(synced.service.loadCached).toHaveBeenCalledWith("feishu-project");
      connectionState = "connected";

      await expect(client.callTool({ name: "list_providers", arguments: {} }))
        .resolves.toMatchObject({
          structuredContent: { providers: [expect.objectContaining({ providerId: "feishu-project" })] },
        });
      await expect(client.callTool({ name: "get_active_provider", arguments: {} }))
        .resolves.toMatchObject({ structuredContent: { activeProviderId: "feishu-project" } });
      const invalidSelection = await client.callTool({
        name: "set_active_provider",
        arguments: { providerId: "not-registered" },
      });
      expect(invalidSelection.isError).toBe(true);
      expect(activeProviderStore.save).not.toHaveBeenCalled();
      await client.callTool({
        name: "set_active_provider",
        arguments: { providerId: "feishu-project" },
      });
      expect(activeProviderStore.save).toHaveBeenCalledWith({
        version: 1,
        activeProviderId: "feishu-project",
      });
      await expect(client.callTool({ name: "get_provider_connection", arguments: {} }))
        .resolves.toMatchObject({ structuredContent: { state: "connected" } });
      const started = await client.callTool({ name: "start_provider_login", arguments: {} });
      expect(started.structuredContent).toMatchObject({
        requestId: expect.any(String),
        session: { sessionId: "session-example", state: "waiting" },
      });
      await expect(client.callTool({ name: "get_provider_login", arguments: {} }))
        .resolves.toMatchObject({
          structuredContent: {
            requestId: expect.any(String),
            session: { sessionId: "session-example" },
          },
        });
      await expect(client.callTool({
        name: "reopen_provider_login",
        arguments: { sessionId: "session-example" },
      })).resolves.toMatchObject({
        structuredContent: { requestId: expect.any(String) },
      });
      await expect(client.callTool({
        name: "cancel_provider_login",
        arguments: { sessionId: "session-example" },
      })).resolves.toMatchObject({
        structuredContent: {
          requestId: expect.any(String),
          session: { state: "cancelled" },
        },
      });
      await client.callTool({ name: "disconnect_provider", arguments: {} });
      expect(auth.disconnect).toHaveBeenCalledOnce();
      expect(synced.service.clearCached).toHaveBeenCalledWith("feishu-project");
      connectionState = "connected";
      const listed = await client.callTool({
        name: "list_work_item_notifications",
        arguments: { unreadOnly: true },
      });
      expect(listed.structuredContent).toMatchObject({
        notifications: [{ id: "notification-1" }],
        unreadCount: 1,
      });
      expect(notificationStore.list).toHaveBeenCalledWith({
        providerId: "feishu-project",
        accountKey: "user_example",
      }, expect.objectContaining({ unreadOnly: true }));
      const marked = await client.callTool({
        name: "mark_work_item_notification_read",
        arguments: { notificationId: "notification-1" },
      });
      expect(marked.structuredContent).toMatchObject({ unreadCount: 0 });
      expect(notificationStore.markRead).toHaveBeenCalledWith(
        { providerId: "feishu-project", accountKey: "user_example" },
        "notification-1",
        expect.any(Date),
      );
      await client.callTool({
        name: "mark_all_work_item_notifications_read",
        arguments: {},
      });
      expect(notificationStore.markAllRead).toHaveBeenCalledWith(
        { providerId: "feishu-project", accountKey: "user_example" },
        expect.any(Date),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists the render and demo tools with UI metadata only on render", async () => {
    const connection = await connectClient(await createBundle());

    try {
      const { tools } = await connection.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "open_my_taskboard",
          "list_my_work_items",
          "refresh_my_work_items",
          "get_work_item_detail",
          "demo_ping",
          "get_connection_status",
          "login_with_tapd_token",
          "disconnect_tapd",
          "discover_projects",
          "save_project_selection",
          "add_project",
          "get_taskboard_preferences",
          "save_taskboard_preferences",
        ]),
      );

      const openTool = tools.find((tool) => tool.name === "open_my_taskboard");
      const pingTool = tools.find((tool) => tool.name === "demo_ping");
      const detailTool = tools.find((tool) => tool.name === "get_work_item_detail");
      const getPreferences = tools.find((tool) => tool.name === "get_taskboard_preferences");
      const savePreferences = tools.find((tool) => tool.name === "save_taskboard_preferences");
      expect(taskboardResourceUri("0.2.1")).toBe(TEST_TASKBOARD_RESOURCE_URI);
      expect(openTool?._meta?.ui).toEqual({ resourceUri: TEST_TASKBOARD_RESOURCE_URI });
      expect(pingTool?._meta?.ui).toBeUndefined();
      expect(detailTool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      });
      expect(Object.keys(detailTool?.inputSchema.properties ?? {}).sort()).toEqual([
        "externalId",
        "projectExternalId",
        "providerId",
        "providerItemType",
      ]);
      expect(getPreferences?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
      expect(getPreferences?._meta?.ui).toBeUndefined();
      expect(getPreferences?.inputSchema.properties).toEqual({});
      expect(savePreferences?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(savePreferences?._meta?.ui).toBeUndefined();
      expect(Object.keys(savePreferences?.inputSchema.properties ?? {})).toEqual([
        "refreshIntervalSeconds",
      ]);
      for (const name of ["discover_projects", "save_project_selection", "add_project"]) {
        expect(tools.find((tool) => tool.name === name)?._meta?.ui).toBeUndefined();
      }
    } finally {
      await connection.close();
    }
  });

  it("reads and saves taskboard preferences without synchronizing work items", async () => {
    const workItems = synchronizer();
    const preferences = {
      get: vi.fn().mockResolvedValue({ refreshIntervalSeconds: 60 }),
      save: vi.fn().mockResolvedValue({ refreshIntervalSeconds: 10 }),
    };
    const connection = await connectClient(
      await createBundle(), authenticator(), catalog().service, undefined,
      workItems.service, undefined, detailReader().service, undefined, preferences,
    );

    try {
      const loaded = await connection.client.callTool({
        name: "get_taskboard_preferences",
        arguments: {},
      });
      const saved = await connection.client.callTool({
        name: "save_taskboard_preferences",
        arguments: { refreshIntervalSeconds: 10 },
      });

      expect(loaded.structuredContent).toEqual({ refreshIntervalSeconds: 60 });
      expect(saved.structuredContent).toEqual({ refreshIntervalSeconds: 10 });
      expect(preferences.save).toHaveBeenCalledWith({ refreshIntervalSeconds: 10 });
      expect(workItems.service.sync).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("returns stable preference errors and logs only approved metadata", async () => {
    const events: Parameters<TaskboardPreferencesOperationLogger["completed"]>[0][] = [];
    const logger: TaskboardPreferencesOperationLogger = {
      completed: (event) => events.push(event),
    };
    const preferences = {
      get: vi.fn().mockRejectedValue(
        new TaskboardPreferencesStoreError("taskboard_preferences_read_failed"),
      ),
      save: vi.fn().mockRejectedValue(
        new TaskboardPreferencesStoreError("taskboard_preferences_write_failed"),
      ),
    };
    const connection = await connectClient(
      await createBundle(), authenticator(), catalog().service, undefined,
      synchronizer().service, undefined, detailReader().service, undefined,
      preferences, logger,
    );

    try {
      const invalid = await connection.client.callTool({
        name: "save_taskboard_preferences",
        arguments: { refreshIntervalSeconds: 4, unknown: "secret-path" },
      });
      const readFailed = await connection.client.callTool({
        name: "get_taskboard_preferences",
        arguments: {},
      });
      const writeFailed = await connection.client.callTool({
        name: "save_taskboard_preferences",
        arguments: { refreshIntervalSeconds: 30 },
      });

      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).toContain("taskboard_preferences_invalid");
      expect(readFailed.isError).toBe(true);
      expect(JSON.stringify(readFailed)).toContain("taskboard_preferences_read_failed");
      expect(writeFailed.isError).toBe(true);
      expect(JSON.stringify(writeFailed)).toContain("taskboard_preferences_write_failed");
      expect(events).toEqual([
        expect.objectContaining({
          requestId: expect.any(String),
          tool: "save_taskboard_preferences",
          outcome: "error",
          errorCode: "taskboard_preferences_invalid",
          durationMs: expect.any(Number),
        }),
        expect.objectContaining({
          requestId: expect.any(String),
          tool: "get_taskboard_preferences",
          outcome: "error",
          errorCode: "taskboard_preferences_read_failed",
          durationMs: expect.any(Number),
        }),
        expect.objectContaining({
          requestId: expect.any(String),
          tool: "save_taskboard_preferences",
          outcome: "error",
          errorCode: "taskboard_preferences_write_failed",
          refreshIntervalSeconds: 30,
          durationMs: expect.any(Number),
        }),
      ]);
      expect(JSON.stringify(events)).not.toMatch(/secret-path|taskboard-preferences\.json|token/i);
    } finally {
      await connection.close();
    }
  });

  it("loads detail using current identity and the accessible project catalog", async () => {
    const fixture = catalog([project("50396062")]);
    const details = detailReader();
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined,
      synchronizer().service, undefined, details.service,
    );

    try {
      const result = await connection.client.callTool({
        name: "get_work_item_detail",
        arguments: {
          providerId: "tapd",
          projectExternalId: "50396062",
          providerItemType: "story",
          externalId: "10001",
        },
      });

      expect(result.structuredContent).toEqual(details.result);
      expect(fixture.service.discover).toHaveBeenCalledOnce();
      expect(details.service.get).toHaveBeenCalledWith({
        reference: {
          providerId: "tapd",
          projectExternalId: "50396062",
          providerItemType: "story",
          externalId: "10001",
        },
        accountDisplayName: "吴晨杰",
        projects: fixture.result.projects,
      });
    } finally {
      await connection.close();
    }
  });

  it("logs one redacted detail event with a request ID", async () => {
    const fixture = catalog([project("50396062")]);
    const details = detailReader();
    const events: Parameters<WorkItemDetailOperationLogger["completed"]>[0][] = [];
    const logger: WorkItemDetailOperationLogger = {
      completed: (event) => events.push(event),
    };
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined,
      synchronizer().service, undefined, details.service, logger,
    );

    try {
      await connection.client.callTool({
        name: "get_work_item_detail",
        arguments: {
          providerId: "tapd",
          projectExternalId: "50396062",
          providerItemType: "story",
          externalId: "10001",
        },
      });

      expect(events).toEqual([expect.objectContaining({
        requestId: expect.any(String),
        tool: "get_work_item_detail",
        providerId: "tapd",
        providerItemType: "story",
        outcome: "success",
        durationMs: expect.any(Number),
      })]);
      expect(JSON.stringify(events)).not.toMatch(
        /50396062|10001|Sensitive|description|吴晨杰|personal-token/i,
      );
    } finally {
      await connection.close();
    }
  });

  it("logs a stable detail error code without sensitive input", async () => {
    const fixture = catalog([project("50396062")]);
    const detailService: WorkItemDetailReader = {
      get: vi.fn().mockRejectedValue(
        new WorkItemDetailProviderError("work_item_detail_forbidden"),
      ),
    };
    const events: Parameters<WorkItemDetailOperationLogger["completed"]>[0][] = [];
    const logger: WorkItemDetailOperationLogger = {
      completed: (event) => events.push(event),
    };
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined,
      synchronizer().service, undefined, detailService, logger,
    );

    try {
      const result = await connection.client.callTool({
        name: "get_work_item_detail",
        arguments: {
          providerId: "tapd",
          projectExternalId: "50396062",
          providerItemType: "story",
          externalId: "10001",
        },
      });

      expect(result.isError).toBe(true);
      expect(events).toEqual([expect.objectContaining({
        requestId: expect.any(String),
        outcome: "error",
        errorCode: "work_item_detail_forbidden",
      })]);
      expect(JSON.stringify(events)).not.toMatch(/50396062|10001|吴晨杰/);
    } finally {
      await connection.close();
    }
  });

  it("calls project catalog tools and returns provider-neutral catalogs", async () => {
    const fixture = catalog([project("50396062")]);
    const connection = await connectClient(
      await createBundle(),
      authenticator(),
      fixture.service,
    );

    try {
      const discovered = await connection.client.callTool({
        name: "discover_projects",
        arguments: { providerId: "tapd" },
      });
      const saved = await connection.client.callTool({
        name: "save_project_selection",
        arguments: { providerId: "tapd", externalIds: ["50396062"] },
      });
      const added = await connection.client.callTool({
        name: "add_project",
        arguments: { providerId: "tapd", input: "https://www.tapd.cn/50396062" },
      });

      expect(discovered.structuredContent).toEqual(fixture.result);
      expect(saved.structuredContent).toEqual(fixture.result);
      expect(added.structuredContent).toEqual(fixture.result);
      expect(fixture.service.discover).toHaveBeenCalledOnce();
      expect(fixture.service.saveSelection).toHaveBeenCalledWith(["50396062"]);
      expect(fixture.service.addProject).toHaveBeenCalledWith("https://www.tapd.cn/50396062");
    } finally {
      await connection.close();
    }
  });

  it("discovers all projects and returns real provider work items", async () => {
    const fixture = catalog([project("50396062"), project("56536239", false)]);
    const workItems = synchronizer(fixture.result.projects);
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined, workItems.service,
    );

    try {
      const result = await connection.client.callTool({
        name: "open_my_taskboard",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        readOnly: true,
        projects: [
          { externalId: "50396062", count: 1 },
          { externalId: "56536239", count: 1 },
        ],
        items: [
          { providerId: "tapd", projectExternalId: "50396062" },
          { providerId: "tapd", projectExternalId: "56536239" },
        ],
      });
      expect(fixture.service.discover).toHaveBeenCalledOnce();
      expect(fixture.service.getCatalog).not.toHaveBeenCalled();
      expect(workItems.service.sync).toHaveBeenCalledWith({
        accountDisplayName: "吴晨杰",
        cacheAccount: {
          providerId: "tapd",
          accountKey: "6081",
          tenantKey: "66238498",
          accountDisplayName: "吴晨杰",
          tenantDisplayName: "FlowRivet 演示企业",
        },
        projects: fixture.result.projects,
      });
    } finally {
      await connection.close();
    }
  });

  it("returns the same provider-neutral snapshot from list and refresh tools", async () => {
    const fixture = catalog([project("50396062")]);
    const workItems = synchronizer(fixture.result.projects);
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined, workItems.service,
    );

    try {
      for (const name of ["list_my_work_items", "refresh_my_work_items"]) {
        const result = await connection.client.callTool({ name, arguments: {} });
        expect(result.structuredContent).toMatchObject({
          readOnly: true,
          items: [{ providerId: "tapd", externalId: "1" }],
          syncSummary: { successfulProjects: 1, failedProjects: 0, itemCount: 1 },
        });
      }
    } finally {
      await connection.close();
    }
  });

  it("logs only aggregate work item operation data", async () => {
    const fixture = catalog([project("sensitive-project-id")]);
    const workItems = synchronizer(fixture.result.projects);
    const events: Parameters<WorkItemOperationLogger["completed"]>[0][] = [];
    const logger: WorkItemOperationLogger = { completed: (event) => events.push(event) };
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined,
      workItems.service, logger,
    );

    try {
      await connection.client.callTool({ name: "open_my_taskboard", arguments: {} });
      expect(events).toEqual([expect.objectContaining({
        requestId: expect.any(String),
        tool: "open_my_taskboard",
        providerId: "tapd",
        outcome: "success",
        successfulProjects: 1,
        failedProjects: 0,
        itemCount: 1,
        dataFreshness: "live",
        freshScopeCount: 3,
        staleScopeCount: 0,
        cacheOutcome: "write_success",
      })]);
      expect(JSON.stringify(events)).not.toMatch(
        /sensitive-project-id|Project sensitive-project-id|Work 1|吴晨杰|example\.test|accountKey|companyId|token/,
      );
    } finally {
      await connection.close();
    }
  });

  it("clears selection and cache before committing another account or disconnecting", async () => {
    const fixture = catalog([project("50396062")]);
    const workItems = synchronizer();
    const events: string[] = [];
    fixture.service.clear = vi.fn().mockImplementation(async () => {
      events.push("clear-project-selection");
    });
    workItems.service.clearCached = vi.fn().mockImplementation(async () => {
      events.push("clear-cache");
    });
    const oldIdentity = { userName: "old-user", accountKey: "old-id", companyId: "tenant" };
    const newIdentity = { userName: "new-user", accountKey: "new-id", companyId: "tenant" };
    const authService: TapdAuthenticator = {
      ...authenticator(),
      getSession: vi.fn().mockResolvedValue({
        result: { ok: true, connection: { tapd: "connected", userName: "old-user" } },
        identity: oldIdentity,
      }),
      validateCandidate: vi.fn().mockImplementation(async () => {
        events.push("validate-candidate");
        return newIdentity;
      }),
      commitCandidate: vi.fn().mockImplementation(async () => {
        events.push("write-token");
        return { ok: true, connection: { tapd: "connected", userName: "new-user" } };
      }),
      disconnect: vi.fn().mockImplementation(async () => {
        events.push("delete-token");
        return { ok: true, connection: { tapd: "disconnected" } };
      }),
    };
    const connection = await connectClient(
      await createBundle(), authService, fixture.service, undefined, workItems.service,
    );

    try {
      await connection.client.callTool({
        name: "login_with_tapd_token",
        arguments: { token: "private-token" },
      });
      expect(events).toEqual([
        "validate-candidate",
        "clear-project-selection",
        "clear-cache",
        "write-token",
      ]);
      await connection.client.callTool({ name: "disconnect_tapd", arguments: {} });
      expect(events).toEqual([
        "validate-candidate",
        "clear-project-selection",
        "clear-cache",
        "write-token",
        "clear-cache",
        "clear-project-selection",
        "delete-token",
      ]);
    } finally {
      await connection.close();
    }
  });

  it("logs one sanitized completion event per project operation", async () => {
    const fixture = catalog([project("sensitive-project-id")]);
    const events: Parameters<ProjectOperationLogger["completed"]>[0][] = [];
    const logger: ProjectOperationLogger = { completed: (event) => events.push(event) };
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, logger,
    );

    try {
      await connection.client.callTool({
        name: "discover_projects",
        arguments: { providerId: "tapd" },
      });
      await connection.client.callTool({
        name: "save_project_selection",
        arguments: { providerId: "tapd", externalIds: ["sensitive-project-id"] },
      });
      await connection.client.callTool({
        name: "add_project",
        arguments: { providerId: "tapd", input: "https://secret.example/sensitive-project-id" },
      });
      expect(events).toHaveLength(3);
      expect(events.map((event) => event.tool)).toEqual([
        "discover_projects",
        "save_project_selection",
        "add_project",
      ]);
      expect(events).toEqual(events.map((event) => expect.objectContaining({
        requestId: expect.any(String),
        providerId: "tapd",
        outcome: "success",
        durationMs: expect.any(Number),
      })));
      const serialized = JSON.stringify(events);
      expect(serialized).not.toMatch(/secret|sensitive-project-id|吴晨杰|Project/);
    } finally {
      await connection.close();
    }
  });

  it("returns the taskboard UI resource", async () => {
    const html = "<html><body>FlowRivet taskboard</body></html>";
    const connection = await connectClient(await createBundle(html));

    try {
      const resource = await connection.client.readResource({
        uri: TEST_TASKBOARD_RESOURCE_URI,
      });
      expect(resource.contents).toEqual([
        expect.objectContaining({
          uri: TEST_TASKBOARD_RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
        }),
      ]);
    } finally {
      await connection.close();
    }
  });

  it("returns an empty unconfigured board and a working demo ping", async () => {
    const connection = await connectClient(await createBundle());

    try {
      const openResult = await connection.client.callTool({
        name: "open_my_taskboard",
        arguments: {},
      });
      const pingResult = await connection.client.callTool({
        name: "demo_ping",
        arguments: { message: "hello" },
      });

      expect(openResult.structuredContent).toMatchObject({
        connection: {
          provider: { providerId: "tapd", state: "connected" },
        },
        projectCatalog: { projects: [], stale: false },
        projects: [],
        items: [],
      });
      expect(pingResult.structuredContent).toMatchObject({
        ok: true,
        message: "hello",
      });
    } finally {
      await connection.close();
    }
  });

  it("returns an empty workspace when TAPD is disconnected", async () => {
    const connection = await connectClient(
      await createBundle(),
      authenticator("disconnected"),
    );

    try {
      const result = await connection.client.callTool({
        name: "open_my_taskboard",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        connection: {
          provider: { providerId: "tapd", state: "disconnected" },
        },
        projects: [],
        items: [],
      });
    } finally {
      await connection.close();
    }
  });

  it("returns cached projects and work items while the TAPD token is expired", async () => {
    const workItems = synchronizer([project("50396062")]);
    workItems.service.loadCached = vi.fn().mockResolvedValue({
      ...workItems.result,
      items: workItems.result.items.map((item) => ({ ...item, freshness: "cached" as const })),
      dataFreshness: "offline",
      freshScopeCount: 0,
      staleScopeCount: 1,
      lastSuccessfulSyncAt: "2026-08-06T00:00:00.000Z",
      lastSyncAttemptAt: "2026-08-07T00:00:00.000Z",
    });
    const connection = await connectClient(
      await createBundle(), authenticator("expired"), catalog().service, undefined,
      workItems.service,
    );

    try {
      const result = await connection.client.callTool({
        name: "open_my_taskboard",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        connection: {
          provider: { providerId: "tapd", state: "expired" },
        },
        dataFreshness: "offline",
        freshScopeCount: 0,
        staleScopeCount: 1,
        freshnessReasonCode: "provider_unauthorized",
        projectCatalog: {
          stale: true,
          projects: [{ externalId: "50396062" }],
        },
        items: [{ freshness: "cached" }],
      });
      expect(workItems.service.sync).not.toHaveBeenCalled();
      expect(workItems.service.loadCached).toHaveBeenCalledWith("tapd");
    } finally {
      await connection.close();
    }
  });

  it("syncs online without a cache namespace when stable identity is missing", async () => {
    const fixture = catalog([project("50396062")]);
    const workItems = synchronizer(fixture.result.projects);
    workItems.service.sync = vi.fn().mockResolvedValue({
      ...workItems.result,
      cacheWarningCode: "cache_identity_unavailable",
    });
    const authService: TapdAuthenticator = {
      ...authenticator(),
      getSession: vi.fn().mockResolvedValue({
        result: {
          ok: true,
          connection: { tapd: "connected", userName: "display-only" },
        },
        identity: { userName: "display-only" },
      }),
    };
    const connection = await connectClient(
      await createBundle(), authService, fixture.service, undefined, workItems.service,
    );

    try {
      const result = await connection.client.callTool({
        name: "open_my_taskboard",
        arguments: {},
      });
      expect(workItems.service.sync).toHaveBeenCalledWith({
        accountDisplayName: "吴晨杰",
        projects: fixture.result.projects,
      });
      expect(result.structuredContent).toMatchObject({
        dataFreshness: "live",
        cacheWarningCode: "cache_identity_unavailable",
      });
    } finally {
      await connection.close();
    }
  });

  it("preserves mixed rate-limit metadata from the service", async () => {
    const fixture = catalog([project("50396062")]);
    const workItems = synchronizer(fixture.result.projects);
    workItems.service.sync = vi.fn().mockResolvedValue({
      ...workItems.result,
      dataFreshness: "mixed",
      freshScopeCount: 2,
      staleScopeCount: 1,
      freshnessReasonCode: "provider_rate_limited",
      retryAfterSeconds: 90,
    });
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined, workItems.service,
    );

    try {
      const result = await connection.client.callTool({
        name: "open_my_taskboard",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        dataFreshness: "mixed",
        freshScopeCount: 2,
        staleScopeCount: 1,
        freshnessReasonCode: "provider_rate_limited",
        retryAfterSeconds: 90,
      });
    } finally {
      await connection.close();
    }
  });

  it("keeps the token when cache cleanup fails during disconnect", async () => {
    const fixture = catalog();
    const workItems = synchronizer();
    workItems.service.clearCached = vi.fn().mockRejectedValue(
      new WorkItemCacheError("cache_clear_failed"),
    );
    const authService = authenticator();
    authService.disconnect = vi.fn(authService.disconnect);
    const connection = await connectClient(
      await createBundle(), authService, fixture.service, undefined, workItems.service,
    );

    try {
      const result = await connection.client.callTool({
        name: "disconnect_tapd",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        errorCode: "cache_clear_failed",
        connection: { tapd: "connected" },
      });
      expect(fixture.service.clear).not.toHaveBeenCalled();
      expect(authService.disconnect).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("retains selection and cache when the candidate belongs to the same account", async () => {
    const fixture = catalog();
    const workItems = synchronizer();
    const identity = {
      userName: "吴晨杰",
      accountKey: "6081",
      companyId: "66238498",
    };
    const authService: TapdAuthenticator = {
      ...authenticator(),
      getSession: vi.fn().mockResolvedValue({
        result: { ok: true, connection: { tapd: "connected", userName: "吴晨杰" } },
        identity,
      }),
      validateCandidate: vi.fn().mockResolvedValue(identity),
      commitCandidate: vi.fn().mockResolvedValue({
        ok: true,
        connection: { tapd: "connected", userName: "吴晨杰" },
      }),
    };
    const connection = await connectClient(
      await createBundle(), authService, fixture.service, undefined, workItems.service,
    );

    try {
      await connection.client.callTool({
        name: "login_with_tapd_token",
        arguments: { token: "replacement-token" },
      });
      expect(fixture.service.clear).not.toHaveBeenCalled();
      expect(workItems.service.clearCached).not.toHaveBeenCalled();
      expect(authService.commitCandidate).toHaveBeenCalledWith("replacement-token", identity);
    } finally {
      await connection.close();
    }
  });

  it("keeps the current session untouched when candidate validation fails", async () => {
    const fixture = catalog();
    const workItems = synchronizer();
    const authService: TapdAuthenticator = {
      ...authenticator(),
      validateCandidate: vi.fn().mockRejectedValue(new TapdIdentityError("invalid_token")),
      commitCandidate: vi.fn(),
    };
    const connection = await connectClient(
      await createBundle(), authService, fixture.service, undefined, workItems.service,
    );

    try {
      const result = await connection.client.callTool({
        name: "login_with_tapd_token",
        arguments: { token: "invalid-candidate" },
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        errorCode: "invalid_token",
        connection: { tapd: "connected", userName: "吴晨杰" },
      });
      expect(fixture.service.clear).not.toHaveBeenCalled();
      expect(workItems.service.clearCached).not.toHaveBeenCalled();
      expect(authService.commitCandidate).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it("logs in without returning the submitted token", async () => {
    const identity = { userName: "吴晨杰", accountKey: "6081" };
    const validateCandidate = vi.fn().mockResolvedValue(identity);
    const commitCandidate = vi.fn().mockResolvedValue({
      ok: true,
      connection: {
        tapd: "connected",
        userName: "吴晨杰",
        companyName: "FlowRivet 测试企业",
      },
    });
    const authService = {
      ...authenticator("disconnected"),
      validateCandidate,
      commitCandidate,
    };
    const connection = await connectClient(await createBundle(), authService);
    const token = "sensitive-personal-token";

    try {
      const result = await connection.client.callTool({
        name: "login_with_tapd_token",
        arguments: { token },
      });
      expect(validateCandidate).toHaveBeenCalledWith(token);
      expect(commitCandidate).toHaveBeenCalledWith(token, identity);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        connection: { tapd: "connected", userName: "吴晨杰" },
      });
      expect(JSON.stringify(result)).not.toContain(token);
    } finally {
      await connection.close();
    }
  });

  it("returns connection status and disconnects without UI metadata", async () => {
    const disconnect = vi.fn().mockResolvedValue({
      ok: true,
      connection: { tapd: "disconnected" },
    });
    const authService = { ...authenticator(), disconnect };
    const connection = await connectClient(await createBundle(), authService);

    try {
      const status = await connection.client.callTool({
        name: "get_connection_status",
        arguments: {},
      });
      const disconnected = await connection.client.callTool({
        name: "disconnect_tapd",
        arguments: {},
      });
      expect(status.structuredContent).toMatchObject({
        connection: { tapd: "connected" },
      });
      expect(disconnected.structuredContent).toMatchObject({
        connection: { tapd: "disconnected" },
      });
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      await connection.close();
    }
  });

  it("reports the exact UI build command when the bundle is missing", async () => {
    const connection = await connectClient(join(tmpdir(), "missing-taskboard.html"));

    try {
      await expect(
        connection.client.readResource({ uri: TEST_TASKBOARD_RESOURCE_URI }),
      ).rejects.toThrow(
        "npm run build:ui --workspace @flowrivet/codex-plugin",
      );
    } finally {
      await connection.close();
    }
  });
});

describe("taskboard HTTP server", () => {
  it("allows loopback bindings and rejects remote bindings", () => {
    for (const host of ["localhost", "127.0.0.1", "::1"]) {
      expect(() => assertLoopbackHost(host)).not.toThrow();
    }
    for (const host of ["0.0.0.0", "10.0.0.8", "flowrivet.internal"]) {
      expect(() => assertLoopbackHost(host)).toThrow("FLOWRIVET_MCP_HOST");
    }
  });

  it("serves health checks and rejects unknown routes", async () => {
    const server = createTaskboardHttpServer({
      uiBundlePath: await createBundle(),
      companionHealth: {
        product: "flowrivet-companion",
        pid: 4321,
        instanceId: "instance-health-test",
        runtimeVersion: "0.2.1",
        protocolVersion: 1,
        uiVersion: "0.2.1",
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    try {
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const health = await fetch(`${baseUrl}/health`);
      const missing = await fetch(`${baseUrl}/missing`);

      await expect(health.json()).resolves.toEqual({
        status: "ok",
        product: "flowrivet-companion",
        pid: 4321,
        instanceId: "instance-health-test",
        version: "0.2.1",
        protocolVersion: 1,
        uiVersion: "0.2.1",
      });
      expect(health.status).toBe(200);
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("allows loopback MCP preflight requests", async () => {
    const server = createTaskboardHttpServer({
      uiBundlePath: await createBundle(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:43120" },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:43120",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects non-loopback MCP origins", async () => {
    const server = createTaskboardHttpServer({
      uiBundlePath: await createBundle(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "OPTIONS",
        headers: { origin: "https://remote.example" },
      });
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe("Origin is not allowed");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
