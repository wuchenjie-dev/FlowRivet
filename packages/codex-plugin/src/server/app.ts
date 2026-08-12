import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  activeProviderSchema,
  providerConnectionSchema,
  providerDescriptorSchema,
  providerLoginLookupResultSchema,
  providerLoginToolResultSchema,
} from "../contracts/providers.js";
import { workItemNotificationListSchema } from "../contracts/notifications.js";
import type { RuntimeServices } from "./runtime-services.js";
import { registerGitLabTools } from "./tools/gitlab-tools.js";
import { registerExecutionTools } from "./tools/execution-tools.js";
import {
  resolveRuntimeVersion,
  runtimeVersionSchema,
  type RuntimeVersion,
} from "../contracts/runtime-version.js";

import { createCredentialStore } from "../auth/credential-store.js";
import {
  TapdAuthService,
  type TapdAuthenticator,
} from "../auth/tapd-auth-service.js";
import {
  TapdIdentityClient,
  TapdIdentityError,
  type TapdIdentity,
} from "../auth/tapd-identity-client.js";
import { authResultSchema, type AuthResult } from "../contracts/auth.js";
import { createWorkItemCacheStore } from "../cache/create-work-item-cache-store.js";
import { WorkItemCacheError } from "../cache/work-item-cache-store.js";
import { projectCatalogSchema } from "../contracts/projects.js";
import {
  taskboardPreferencesSchema,
  type TaskboardPreferences,
} from "../contracts/taskboard-preferences.js";
import { canonicalStages, taskboardSnapshotSchema } from "../contracts/taskboard.js";
import {
  workItemDetailRefSchema,
  workItemDetailSchema,
} from "../contracts/work-item-detail.js";
import {
  JsonStderrProjectOperationLogger,
  type ProjectOperationLogger,
  type ProjectToolName,
} from "../observability/project-operation-logger.js";
import {
  JsonStderrWorkItemDetailOperationLogger,
  type WorkItemDetailOperationLogger,
} from "../observability/work-item-detail-operation-logger.js";
import {
  JsonStderrWorkItemOperationLogger,
  type WorkItemOperationLogger,
  type WorkItemToolName,
} from "../observability/work-item-operation-logger.js";
import {
  JsonStderrTaskboardPreferencesOperationLogger,
  type TaskboardPreferencesOperationLogger,
  type TaskboardPreferencesToolName,
} from "../observability/taskboard-preferences-operation-logger.js";
import {
  JsonStderrNotificationOperationLogger,
  type NotificationOperationLogger,
  type NotificationToolName,
} from "../observability/notification-operation-logger.js";
import { JsonTaskboardPreferencesStore } from "../preferences/json-taskboard-preferences-store.js";
import { TaskboardPreferencesService } from "../preferences/taskboard-preferences-service.js";
import { TaskboardPreferencesStoreError } from "../preferences/taskboard-preferences-store.js";
import {
  JsonProjectSelectionStore,
  resolveFlowRivetConfigDirectory,
} from "../projects/json-project-selection-store.js";
import {
  ProjectCatalogService,
  type ProjectCatalog,
} from "../projects/project-catalog-service.js";
import { ProjectProviderError } from "../projects/project-management-provider.js";
import { ProjectSelectionStoreError } from "../projects/project-selection-store.js";
import {
  StoredTapdProjectCredentialResolver,
  TapdProjectProvider,
} from "../projects/tapd-project-provider.js";
import {
  WorkItemService,
  type WorkItemSyncSnapshot,
  type WorkItemSynchronizer,
} from "../work-items/work-item-service.js";
import { TapdWorkItemProvider } from "../work-items/tapd-work-item-provider.js";
import { TapdWorkItemDetailProvider } from "../work-items/tapd-work-item-detail-provider.js";
import {
  WorkItemDetailService,
  type WorkItemDetailReader,
} from "../work-items/work-item-detail-service.js";
import { WorkItemDetailProviderError } from "../work-items/work-item-detail-provider.js";

export function taskboardResourceUri(uiVersion: string) {
  return `ui://flowrivet/taskboard/${encodeURIComponent(uiVersion)}.html`;
}

const DEFAULT_UI_BUNDLE_PATH = fileURLToPath(
  new URL("../ui/taskboard.html", import.meta.url),
);

export interface TaskboardMcpServerOptions {
  uiBundlePath?: string;
  now?: () => Date;
  authService?: TapdAuthenticator;
  projectCatalog?: ProjectCatalog;
  projectLogger?: ProjectOperationLogger;
  workItemService?: WorkItemSynchronizer;
  workItemLogger?: WorkItemOperationLogger;
  workItemDetailService?: WorkItemDetailReader;
  workItemDetailLogger?: WorkItemDetailOperationLogger;
  taskboardPreferences?: TaskboardPreferencesReaderWriter;
  taskboardPreferencesLogger?: TaskboardPreferencesOperationLogger;
  notificationLogger?: NotificationOperationLogger;
  runtimeServices?: RuntimeServices;
  runtimeVersion?: RuntimeVersion;
}

export interface TaskboardPreferencesReaderWriter {
  get(): Promise<TaskboardPreferences>;
  save(preferences: TaskboardPreferences): Promise<TaskboardPreferences>;
}

export function createDefaultWorkItemSynchronizer(
  now: () => Date = () => new Date(),
): WorkItemSynchronizer {
  const credentialStore = createCredentialStore();
  const credentialResolver = new StoredTapdProjectCredentialResolver({
    store: credentialStore,
    identityClient: new TapdIdentityClient(),
  });
  return new WorkItemService(
    new TapdWorkItemProvider({ credentialResolver }),
    now,
    createWorkItemCacheStore(),
  );
}

export function createTaskboardMcpServer(
  options: TaskboardMcpServerOptions = {},
) {
  const uiBundlePath = options.uiBundlePath ?? DEFAULT_UI_BUNDLE_PATH;
  const runtimeVersion = options.runtimeVersion ?? resolveRuntimeVersion();
  const resourceUri = taskboardResourceUri(runtimeVersion.uiVersion);
  const runtimeServices = options.runtimeServices;
  const now = options.now ?? (() => new Date());
  const credentialStore = createCredentialStore();
  const identityClient = new TapdIdentityClient();
  const authService = options.authService ?? new TapdAuthService({
    store: credentialStore,
    identityClient,
  });
  const credentialResolver = new StoredTapdProjectCredentialResolver({
    store: credentialStore,
    identityClient,
  });
  const projectCatalog = options.projectCatalog ?? new ProjectCatalogService(
    new TapdProjectProvider({
      credentialResolver,
    }),
    new JsonProjectSelectionStore({ directory: resolveFlowRivetConfigDirectory() }),
    now,
  );
  const projectLogger = options.projectLogger ?? new JsonStderrProjectOperationLogger();
  const workItemService = options.workItemService
    ?? createDefaultWorkItemSynchronizer(now);
  const workItemLogger = options.workItemLogger ?? new JsonStderrWorkItemOperationLogger();
  const workItemDetailService = options.workItemDetailService ?? new WorkItemDetailService(
    new TapdWorkItemDetailProvider({ credentialResolver }),
  );
  const workItemDetailLogger = options.workItemDetailLogger
    ?? new JsonStderrWorkItemDetailOperationLogger();
  const taskboardPreferences = options.taskboardPreferences
    ?? new TaskboardPreferencesService(new JsonTaskboardPreferencesStore({
      directory: resolveFlowRivetConfigDirectory(),
    }));
  const taskboardPreferencesLogger = options.taskboardPreferencesLogger
    ?? new JsonStderrTaskboardPreferencesOperationLogger();
  const notificationLogger = options.notificationLogger
    ?? new JsonStderrNotificationOperationLogger();
  const server = new McpServer({ name: "flowrivet", version: runtimeVersion.version });
  if (runtimeServices?.gitLabService) registerGitLabTools(server, runtimeServices.gitLabService);
  if (runtimeServices?.executionService) registerExecutionTools(server, {
    service: runtimeServices.executionService,
    repositoryWorkflow: runtimeServices.repositoryWorkflow,
    resolveAccountKey: async () => {
      const active = await runtimeServices.activeProviderStore.load({
        registeredProviderIds: runtimeServices.registry.ids(),
      });
      if (active.activeProviderId !== "feishu-project") throw new Error("execution_provider_unsupported");
      const identity = runtimeServices.registry.get(active.activeProviderId).auth.getSessionIdentity?.();
      if (!identity?.accountKey) throw new Error("provider_identity_validation_failed");
      return identity.accountKey;
    },
  });

  registerAppTool(
    server,
    "get_runtime_version",
    {
      title: "读取 FlowRivet 运行时版本",
      description: "读取当前 Companion 和看板 UI 的兼容版本。",
      inputSchema: {},
      outputSchema: runtimeVersionSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: {},
    },
    async () => ({
      content: [{ type: "text", text: `FlowRivet ${runtimeVersion.version}` }],
      structuredContent: runtimeVersion,
    }),
  );

  registerAppResource(
    server,
    "FlowRivet 我的待办看板",
    resourceUri,
    { description: "FlowRivet 待办看板 React UI" },
    async () => {
      let html: string;
      try {
        html = await readFile(uiBundlePath, "utf8");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          "FlowRivet UI bundle is unavailable. Run " +
            "`npm run build:ui --workspace @flowrivet/codex-plugin`. " +
            `Cause: ${reason}`,
        );
      }

      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
          },
        ],
      };
    },
  );

  const snapshotBuilder = runtimeServices ? buildProviderTaskboardSnapshot : buildTaskboardSnapshot;
  registerWorkItemTool(server, workItemLogger, "open_my_taskboard", {
    title: "打开我的待办看板",
    description: "打开当前项目管理系统中的真实只读待办看板。",
    resourceUri,
    run: snapshotBuilder,
    providerIdOnError: runtimeServices ? "feishu-project" : "tapd",
  });
  registerWorkItemTool(server, workItemLogger, "list_my_work_items", {
    title: "列出我的工作项",
    description: "读取当前用户在全部可访问项目中的真实工作项。",
    run: snapshotBuilder,
    providerIdOnError: runtimeServices ? "feishu-project" : "tapd",
  });
  registerWorkItemTool(server, workItemLogger, "refresh_my_work_items", {
    title: "刷新我的工作项",
    description: "重新发现项目并刷新真实只读工作项。",
    run: snapshotBuilder,
    providerIdOnError: runtimeServices ? "feishu-project" : "tapd",
  });

  registerTaskboardPreferencesTool(
    server,
    taskboardPreferencesLogger,
    "get_taskboard_preferences",
    {
      title: "读取看板刷新设置",
      description: "读取本机保存的看板自动刷新频率。",
      inputSchema: {},
      run: () => taskboardPreferences.get(),
    },
  );
  registerTaskboardPreferencesTool(
    server,
    taskboardPreferencesLogger,
    "save_taskboard_preferences",
    {
      title: "保存看板刷新设置",
      description: "在本机保存看板自动刷新频率。",
      inputSchema: { refreshIntervalSeconds: z.any() },
      run: (input) => taskboardPreferences.save(taskboardPreferencesSchema.parse(input)),
    },
  );

  if (!runtimeServices) registerAppTool(
    server,
    "get_work_item_detail",
    {
      title: "查看工作项详情",
      description: "实时读取当前用户可访问且分配给自己的工作项详情。",
      inputSchema: workItemDetailRefSchema.shape,
      outputSchema: workItemDetailSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {},
    },
    async (input) => {
      const reference = workItemDetailRefSchema.parse(input);
      const requestId = randomUUID();
      const startedAt = performance.now();
      try {
        const auth = await authService.getConnectionStatus();
        if (auth.connection.tapd !== "connected") {
          throw new WorkItemDetailProviderError(
            auth.connection.tapd === "expired"
              ? "provider_unauthorized"
              : "provider_not_connected",
          );
        }
        const catalog = await projectCatalog.discover();
        const accountDisplayName = catalog.provider.accountDisplayName
          ?? auth.connection.userName;
        if (!accountDisplayName) {
          throw new WorkItemDetailProviderError("provider_unauthorized");
        }
        const detail = workItemDetailSchema.parse(await workItemDetailService.get({
          reference,
          accountDisplayName,
          projects: catalog.projects,
        }));
        workItemDetailLogger.completed({
          requestId,
          tool: "get_work_item_detail",
          providerId: reference.providerId,
          providerItemType: reference.providerItemType,
          outcome: "success",
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
        return {
          structuredContent: detail,
          content: [{ type: "text" as const, text: "工作项详情已加载。" }],
        };
      } catch (error) {
        workItemDetailLogger.completed({
          requestId,
          tool: "get_work_item_detail",
          providerId: reference.providerId,
          providerItemType: reference.providerItemType,
          outcome: "error",
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          ...projectErrorCode(error),
        });
        throw error;
      }
    },
  );

  async function buildTaskboardSnapshot() {
    const syncAttemptAt = now().toISOString();
    const session = await authService.getSession();
    const auth = session.result;
    const connected = auth.connection.tapd === "connected";
    const liveCatalog = connected ? await projectCatalog.discover() : undefined;
    let synchronized: WorkItemSyncSnapshot | undefined;
    if (connected && liveCatalog) {
      synchronized = await workItemService.sync({
        accountDisplayName: liveCatalog.provider.accountDisplayName
          ?? auth.connection.userName
          ?? "",
        projects: liveCatalog.projects.filter((project) => project.available),
        ...(session.identity?.accountKey ? {
          cacheAccount: {
            providerId: "tapd",
            accountKey: session.identity.accountKey,
            ...(session.identity.companyId ? { tenantKey: session.identity.companyId } : {}),
            accountDisplayName: session.identity.userName,
            ...(session.identity.companyName
              ? { tenantDisplayName: session.identity.companyName }
              : {}),
          },
        } : {}),
      });
    } else {
      try {
        synchronized = await workItemService.loadCached("tapd");
      } catch (error) {
        synchronized = {
          ...emptyWorkItemSnapshot(syncAttemptAt),
          ...(error instanceof WorkItemCacheError && error.code !== "cache_clear_failed"
            ? { cacheWarningCode: error.code }
            : { cacheWarningCode: "cache_read_failed" as const }),
        };
      }
    }
    synchronized ??= emptyWorkItemSnapshot(syncAttemptAt);
    const catalog = liveCatalog ?? {
      provider: {
        providerId: "tapd",
        displayName: "TAPD",
        state: auth.connection.tapd,
        ...(auth.connection.userName
          ? { accountDisplayName: auth.connection.userName }
          : {}),
        ...(auth.connection.companyName
          ? { tenantDisplayName: auth.connection.companyName }
          : {}),
      },
      projects: synchronized.projects.map(({ count: _count, ...project }) => project),
      stale: synchronized.dataFreshness === "offline",
    };
    const freshnessReasonCode = connected
      ? synchronized.freshnessReasonCode
      : offlineReason(auth);
    return taskboardSnapshotSchema.parse({
      projectCatalog: catalog,
      projects: synchronized.projects,
      items: synchronized.items,
      readOnly: true,
      syncSummary: synchronized.summary,
      stages: canonicalStages,
      dataFreshness: synchronized.dataFreshness,
      freshScopeCount: synchronized.freshScopeCount,
      staleScopeCount: synchronized.staleScopeCount,
      ...(synchronized.lastSuccessfulSyncAt
        ? { lastSuccessfulSyncAt: synchronized.lastSuccessfulSyncAt }
        : {}),
      lastSyncAttemptAt: synchronized.lastSyncAttemptAt,
      ...(synchronized.cacheWarningCode
        ? { cacheWarningCode: synchronized.cacheWarningCode }
        : {}),
      ...(freshnessReasonCode ? { freshnessReasonCode } : {}),
      ...(freshnessReasonCode === "provider_rate_limited"
        && synchronized.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: synchronized.retryAfterSeconds }
        : {}),
      lastSyncedAt: synchronized.lastSuccessfulSyncAt ?? syncAttemptAt,
      connection: { provider: catalog.provider, gitlab: "not_configured" },
    });
  }

  async function buildProviderTaskboardSnapshot() {
    if (!runtimeServices) throw new Error("provider_runtime_unavailable");
    const syncAttemptAt = now().toISOString();
    const providerIds = runtimeServices.registry.ids();
    const active = await runtimeServices.activeProviderStore.load({
      registeredProviderIds: providerIds,
    });
    const registration = runtimeServices.registry.get(active.activeProviderId);
    const connection = await registration.auth.getConnection();
    const synchronizer = runtimeServices.workItemServices.get(registration.id);
    if (!synchronizer) throw new Error("provider_runtime_unavailable");
    let synchronized: WorkItemSyncSnapshot | undefined;

    if (connection.state === "connected") {
      const identity = registration.auth.getSessionIdentity?.();
      try {
        synchronized = await synchronizer.sync({
          accountDisplayName: identity?.accountDisplayName
            ?? connection.accountDisplayName
            ?? "",
          projects: [],
          ...(identity?.profileName ? { syncSessionKey: identity.profileName } : {}),
          ...(identity?.accountKey ? {
            cacheAccount: {
              providerId: registration.id,
              accountKey: identity.accountKey,
              ...(identity.tenantKey ? { tenantKey: identity.tenantKey } : {}),
              accountDisplayName: identity.accountDisplayName,
              ...(identity.tenantDisplayName
                ? { tenantDisplayName: identity.tenantDisplayName }
                : {}),
            },
          } : {}),
        });
      } catch (error) {
        synchronized = await synchronizer.loadCached(registration.id);
        if (!synchronized) throw error;
      }
    } else {
      try {
        synchronized = await synchronizer.loadCached(registration.id);
      } catch (error) {
        synchronized = {
          ...emptyWorkItemSnapshot(syncAttemptAt),
          ...(error instanceof WorkItemCacheError && error.code !== "cache_clear_failed"
            ? { cacheWarningCode: error.code }
            : { cacheWarningCode: "cache_read_failed" as const }),
        };
      }
    }
    synchronized ??= emptyWorkItemSnapshot(syncAttemptAt);
    const projects = synchronized.projects.map(({ count: _count, ...project }) => project);
    const freshnessReasonCode = connection.state === "expired"
      ? "provider_unauthorized" as const
      : connection.state === "unavailable"
        ? "provider_unavailable" as const
        : synchronized.freshnessReasonCode;
    return taskboardSnapshotSchema.parse({
      connection: { provider: connection, gitlab: "not_configured" },
      projectCatalog: {
        provider: connection,
        projects,
        stale: synchronized.dataFreshness === "offline",
      },
      projects: synchronized.projects,
      items: synchronized.items,
      readOnly: true,
      syncSummary: synchronized.summary,
      stages: canonicalStages,
      dataFreshness: synchronized.dataFreshness,
      freshScopeCount: synchronized.freshScopeCount,
      staleScopeCount: synchronized.staleScopeCount,
      ...(synchronized.lastSuccessfulSyncAt
        ? { lastSuccessfulSyncAt: synchronized.lastSuccessfulSyncAt }
        : {}),
      lastSyncAttemptAt: synchronized.lastSyncAttemptAt,
      ...(synchronized.cacheWarningCode
        ? { cacheWarningCode: synchronized.cacheWarningCode }
        : {}),
      ...(freshnessReasonCode ? { freshnessReasonCode } : {}),
      ...(freshnessReasonCode === "provider_rate_limited"
        && synchronized.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: synchronized.retryAfterSeconds }
        : {}),
      lastSyncedAt: synchronized.lastSuccessfulSyncAt ?? syncAttemptAt,
    });
  }

  if (!runtimeServices) registerAppTool(
    server,
    "get_connection_status",
    {
      title: "检查 TAPD 连接状态",
      description: "验证本机 TAPD 凭据并返回非敏感连接状态。",
      inputSchema: {},
      outputSchema: authResultSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {},
    },
    async () => authToolResult(await authService.getConnectionStatus()),
  );

  if (!runtimeServices) registerAppTool(
    server,
    "login_with_tapd_token",
    {
      title: "使用 TAPD Token 登录",
      description: "验证个人 Token 并使用本机安全存储保存。不得在对话或日志中回显 Token。",
      inputSchema: { token: z.string().min(1) },
      outputSchema: authResultSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: {},
    },
    async ({ token }) => {
      const before = await authService.getSession();
      let candidate: TapdIdentity;
      try {
        candidate = await authService.validateCandidate(token);
      } catch (error) {
        return authToolResult(authFailure(error, before.result.connection));
      }
      if (sessionIdentityChanged(before, candidate)) {
        try {
          await projectCatalog.clear();
        } catch (error) {
          return authToolResult(authFailure(error, before.result.connection));
        }
        try {
          await workItemService.clearCached("tapd");
        } catch (error) {
          return authToolResult(authFailure(error, before.result.connection));
        }
      }
      const committed = await authService.commitCandidate(token, candidate);
      return authToolResult(committed.ok ? committed : {
        ...committed,
        connection: before.result.connection,
      });
    },
  );

  if (!runtimeServices) registerAppTool(
    server,
    "disconnect_tapd",
    {
      title: "断开 TAPD",
      description: "删除本机保存的 TAPD 凭据。",
      inputSchema: {},
      outputSchema: authResultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: {},
    },
    async () => {
      const before = await authService.getConnectionStatus();
      try {
        await workItemService.clearCached("tapd");
        await projectCatalog.clear();
      } catch (error) {
        return authToolResult(authFailure(error, before.connection));
      }
      return authToolResult(await authService.disconnect());
    },
  );

  if (!runtimeServices) registerProjectTool(server, projectLogger, projectCatalog, "discover_projects", {
    title: "发现项目",
    description: "从当前项目管理系统发现可访问项目。",
    inputSchema: { providerId: z.string().min(1) },
    run: (catalog) => catalog.discover(),
  });

  if (!runtimeServices) registerProjectTool(server, projectLogger, projectCatalog, "save_project_selection", {
    title: "保存项目选择",
    description: "保存当前账号要纳入看板的项目。",
    inputSchema: {
      providerId: z.string().min(1),
      externalIds: z.array(z.string().min(1)),
    },
    run: (catalog, input) => catalog.saveSelection(input.externalIds as string[]),
  });

  if (!runtimeServices) registerProjectTool(server, projectLogger, projectCatalog, "add_project", {
    title: "手工添加项目",
    description: "通过项目 ID 或 URL 验证并添加一个项目。",
    inputSchema: {
      providerId: z.string().min(1),
      input: z.string().min(1),
    },
    run: (catalog, input) => catalog.addProject(input.input as string),
  });

  if (runtimeServices) {
    const activeProviderSchemaWithWarning = activeProviderSchema.extend({
      warningCode: z.literal("active_provider_unavailable").optional(),
    });
    const activeProvider = () => runtimeServices.activeProviderStore.load({
      registeredProviderIds: runtimeServices.registry.ids(),
    });
    registerAppTool(server, "list_providers", {
      title: "列出项目管理系统",
      description: "列出本地已注册项目管理系统及非敏感连接状态。",
      inputSchema: {},
      outputSchema: { providers: z.array(providerDescriptorSchema) },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {},
    }, async () => ({
      structuredContent: { providers: await runtimeServices.registry.list() },
      content: [{ type: "text" as const, text: "项目管理系统列表已加载。" }],
    }));
    registerAppTool(server, "get_active_provider", {
      title: "读取当前项目管理系统",
      description: "读取当前看板使用的项目管理系统。",
      inputSchema: {},
      outputSchema: activeProviderSchemaWithWarning.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: {},
    }, async () => {
      const result = await activeProvider();
      return { structuredContent: result, content: [{ type: "text" as const, text: "当前项目管理系统已加载。" }] };
    });
    registerAppTool(server, "set_active_provider", {
      title: "切换项目管理系统",
      description: "切换当前看板使用的已注册项目管理系统。",
      inputSchema: { providerId: z.string().min(1) },
      outputSchema: activeProviderSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: {},
    }, async ({ providerId }) => {
      runtimeServices.registry.get(providerId);
      const selection = activeProviderSchema.parse({ version: 1, activeProviderId: providerId });
      await runtimeServices.activeProviderStore.save(selection);
      return { structuredContent: selection, content: [{ type: "text" as const, text: "项目管理系统已切换。" }] };
    });
    registerAppTool(server, "get_provider_connection", {
      title: "检查项目管理系统连接",
      description: "检查当前项目管理系统的非敏感连接状态。",
      inputSchema: {},
      outputSchema: providerConnectionSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {},
    }, async () => {
      const active = await activeProvider();
      const result = await runtimeServices.registry.get(active.activeProviderId).auth.getConnection();
      return { structuredContent: result, content: [{ type: "text" as const, text: "连接状态已更新。" }] };
    });
    registerAppTool(server, "start_provider_login", {
      title: "连接项目管理系统",
      description: "启动当前项目管理系统的用户授权流程。",
      inputSchema: {},
      outputSchema: providerLoginToolResultSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: {},
    }, async () => {
      const active = await activeProvider();
      const requestId = randomUUID();
      const session = await runtimeServices.loginCoordinator.start(
        active.activeProviderId,
        requestId,
      );
      const result = providerLoginToolResultSchema.parse({ requestId, session });
      return { structuredContent: result, content: [{ type: "text" as const, text: "授权流程已启动。" }] };
    });
    registerAppTool(server, "get_provider_login", {
      title: "读取项目管理系统授权",
      description: "读取当前项目管理系统的活动或最近授权会话。",
      inputSchema: {},
      outputSchema: providerLoginLookupResultSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: {},
    }, async () => {
      const active = await activeProvider();
      const requestId = randomUUID();
      const session = runtimeServices.loginCoordinator.get(active.activeProviderId);
      const result = providerLoginLookupResultSchema.parse({ requestId, ...(session ? { session } : {}) });
      return { structuredContent: result, content: [{ type: "text" as const, text: "授权状态已读取。" }] };
    });
    registerAppTool(server, "reopen_provider_login", {
      title: "重新打开项目管理系统授权",
      description: "重新打开当前活动授权会话的系统浏览器页面。",
      inputSchema: { sessionId: z.string().min(1) },
      outputSchema: providerLoginToolResultSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: {},
    }, async ({ sessionId }) => {
      const active = await activeProvider();
      const requestId = randomUUID();
      const session = await runtimeServices.loginCoordinator.reopen(
        active.activeProviderId,
        sessionId,
        requestId,
      );
      const result = providerLoginToolResultSchema.parse({ requestId, session });
      return { structuredContent: result, content: [{ type: "text" as const, text: "授权页面已重新打开。" }] };
    });
    registerAppTool(server, "cancel_provider_login", {
      title: "取消项目管理系统授权",
      description: "取消当前内存中的用户授权流程。",
      inputSchema: { sessionId: z.string().min(1) },
      outputSchema: providerLoginToolResultSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: {},
    }, async ({ sessionId }) => {
      const active = await activeProvider();
      const requestId = randomUUID();
      const session = await runtimeServices.loginCoordinator.cancel(
        active.activeProviderId,
        sessionId,
        requestId,
      );
      const result = providerLoginToolResultSchema.parse({ requestId, session });
      return { structuredContent: result, content: [{ type: "text" as const, text: "授权流程已取消。" }] };
    });
    registerAppTool(server, "disconnect_provider", {
      title: "断开项目管理系统",
      description: "断开当前项目管理系统并清除其活跃缓存。",
      inputSchema: {},
      outputSchema: providerConnectionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: {},
    }, async () => {
      const active = await activeProvider();
      const registration = runtimeServices.registry.get(active.activeProviderId);
      if (!registration.auth.disconnect) throw new Error("provider_capability_unsupported");
      const result = await registration.auth.disconnect();
      await runtimeServices.workItemServices.get(registration.id)?.clearCached(registration.id);
      return { structuredContent: result, content: [{ type: "text" as const, text: "项目管理系统已断开。" }] };
    });

    const notificationAccount = async () => {
      const active = await activeProvider();
      const registration = runtimeServices.registry.get(active.activeProviderId);
      const connection = await registration.auth.getConnection();
      if (connection.state !== "connected") throw new Error("provider_not_connected");
      const identity = registration.auth.getSessionIdentity?.();
      if (!identity?.accountKey) throw new Error("provider_identity_validation_failed");
      return {
        providerId: registration.id,
        account: { providerId: registration.id, accountKey: identity.accountKey },
      };
    };
    const runNotificationTool = async (
      tool: NotificationToolName,
      operation: (account: { providerId: string; accountKey: string }) => Promise<unknown>,
    ) => {
      const requestId = randomUUID();
      const started = now().getTime();
      let providerId = "unknown";
      try {
        const resolved = await notificationAccount();
        providerId = resolved.providerId;
        const result = workItemNotificationListSchema.parse(
          await operation(resolved.account),
        );
        notificationLogger.completed({
          requestId,
          tool,
          providerId,
          outcome: "success",
          durationMs: Math.max(0, now().getTime() - started),
          notificationCount: result.notifications.length,
          unreadCount: result.unreadCount,
        });
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: "本地通知已更新。" }],
        };
      } catch (error) {
        notificationLogger.completed({
          requestId,
          tool,
          providerId,
          outcome: "error",
          durationMs: Math.max(0, now().getTime() - started),
          errorCode: notificationErrorCode(error),
        });
        throw error;
      }
    };
    registerAppTool(server, "list_work_item_notifications", {
      title: "读取工作项通知",
      description: "读取当前账号最近 30 天的本地工作项变化通知。",
      inputSchema: { unreadOnly: z.boolean().optional() },
      outputSchema: workItemNotificationListSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: {},
    }, ({ unreadOnly }) => runNotificationTool(
      "list_work_item_notifications",
      (account) => runtimeServices.notificationStore.list(account, {
        now: now(),
        ...(unreadOnly === true ? { unreadOnly: true } : {}),
      }),
    ));
    registerAppTool(server, "mark_work_item_notification_read", {
      title: "标记工作项通知已读",
      description: "幂等标记当前账号的一条本地通知已读。",
      inputSchema: { notificationId: z.string().min(1) },
      outputSchema: workItemNotificationListSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: {},
    }, ({ notificationId }) => runNotificationTool(
      "mark_work_item_notification_read",
      async (account) => {
        await runtimeServices.notificationStore.markRead(account, notificationId, now());
        return runtimeServices.notificationStore.list(account, { now: now() });
      },
    ));
    registerAppTool(server, "mark_all_work_item_notifications_read", {
      title: "全部工作项通知已读",
      description: "幂等标记当前账号的全部本地通知已读。",
      inputSchema: {},
      outputSchema: workItemNotificationListSchema.shape,
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: {},
    }, () => runNotificationTool(
      "mark_all_work_item_notifications_read",
      async (account) => {
        await runtimeServices.notificationStore.markAllRead(account, now());
        return runtimeServices.notificationStore.list(account, { now: now() });
      },
    ));
  }

  registerAppTool(
    server,
    "demo_ping",
    {
      title: "检查本地 Companion",
      description: "验证 FlowRivet UI 到本地 Companion 的 MCP Apps bridge。",
      inputSchema: { message: z.string().optional() },
      outputSchema: {
        ok: z.boolean(),
        message: z.string().optional(),
        repliedAt: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: {},
    },
    async ({ message }) => ({
      structuredContent: {
        ok: true,
        ...(message ? { message } : {}),
        repliedAt: now().toISOString(),
      },
      content: [{ type: "text", text: "FlowRivet 本地 Companion 已响应。" }],
    }),
  );

  return server;
}

function notificationErrorCode(error: unknown) {
  if (error instanceof Error && [
    "provider_not_connected",
    "provider_identity_validation_failed",
    "notification_store_read_failed",
    "notification_store_write_failed",
  ].includes(error.message)) return error.message;
  return "notification_operation_failed";
}

function registerTaskboardPreferencesTool(
  server: McpServer,
  logger: TaskboardPreferencesOperationLogger,
  tool: TaskboardPreferencesToolName,
  options: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodType>;
    run: (input: Record<string, unknown>) => Promise<TaskboardPreferences>;
  },
) {
  registerAppTool(server, tool, {
    title: options.title,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: taskboardPreferencesSchema.shape,
    annotations: tool === "get_taskboard_preferences"
      ? { readOnlyHint: true, openWorldHint: false }
      : {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
    _meta: {},
  }, async (input) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    try {
      const preferences = taskboardPreferencesSchema.parse(await options.run(input));
      logger.completed({
        requestId,
        tool,
        outcome: "success",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        refreshIntervalSeconds: preferences.refreshIntervalSeconds,
      });
      return {
        structuredContent: preferences,
        content: [{ type: "text" as const, text: "看板刷新设置已更新。" }],
      };
    } catch (error) {
      const errorCode = taskboardPreferencesErrorCode(error);
      logger.completed({
        requestId,
        tool,
        outcome: "error",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(typeof input.refreshIntervalSeconds === "number"
          && taskboardPreferencesSchema.safeParse(input).success
          ? { refreshIntervalSeconds: input.refreshIntervalSeconds }
          : {}),
        errorCode,
      });
      throw new Error(errorCode);
    }
  });
}

function taskboardPreferencesErrorCode(error: unknown) {
  if (error instanceof z.ZodError) return "taskboard_preferences_invalid" as const;
  if (error instanceof TaskboardPreferencesStoreError) return error.code;
  return "taskboard_preferences_write_failed" as const;
}

function registerProjectTool(
  server: McpServer,
  logger: ProjectOperationLogger,
  catalog: ProjectCatalog,
  tool: ProjectToolName,
  options: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodType>;
    run: (catalog: ProjectCatalog, input: Record<string, unknown>) => Promise<unknown>;
  },
) {
  registerAppTool(server, tool, {
    title: options.title,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: projectCatalogSchema.shape,
    annotations: { readOnlyHint: tool === "discover_projects", openWorldHint: true },
    _meta: {},
  }, async (input) => {
    const providerId = String(input.providerId);
    const requestId = randomUUID();
    const startedAt = performance.now();
    try {
      if (providerId !== "tapd") {
        throw new ProjectProviderError("provider_not_connected");
      }
      const result = projectCatalogSchema.parse(await options.run(catalog, input));
      logger.completed({
        requestId, tool, providerId, outcome: "success",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      return {
        structuredContent: result,
        content: [{ type: "text" as const, text: "项目目录已更新。" }],
      };
    } catch (error) {
      logger.completed({
        requestId, tool, providerId, outcome: "error",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...projectErrorCode(error),
      });
      throw error;
    }
  });
}

function registerWorkItemTool(
  server: McpServer,
  logger: WorkItemOperationLogger,
  tool: WorkItemToolName,
  options: {
    title: string;
    description: string;
    resourceUri?: string;
    run: () => Promise<unknown>;
    providerIdOnError?: string;
  },
) {
  registerAppTool(server, tool, {
    title: options.title,
    description: options.description,
    inputSchema: {},
    outputSchema: taskboardSnapshotSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: options.resourceUri ? { ui: { resourceUri: options.resourceUri } } : {},
  }, async () => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    try {
      const snapshot = taskboardSnapshotSchema.parse(await options.run());
      logger.completed({
        requestId,
        tool,
        providerId: snapshot.connection.provider.providerId,
        outcome: snapshot.syncSummary.failedProjects > 0 ? "partial" : "success",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...snapshot.syncSummary,
        dataFreshness: snapshot.dataFreshness,
        freshScopeCount: snapshot.freshScopeCount,
        staleScopeCount: snapshot.staleScopeCount,
        cacheOutcome: cacheOutcome(snapshot),
      });
      return {
        structuredContent: snapshot,
        content: [{
          type: "text" as const,
          text: snapshot.dataFreshness === "offline"
            ? `FlowRivet 已加载 ${snapshot.syncSummary.itemCount} 个缓存工作项。`
            : snapshot.connection.provider.state === "connected"
            ? `FlowRivet 看板已同步 ${snapshot.syncSummary.itemCount} 个工作项。`
            : `FlowRivet 看板已打开，请先连接${snapshot.connection.provider.displayName}。`,
        }],
      };
    } catch (error) {
      logger.completed({
        requestId,
        tool,
        providerId: options.providerIdOnError ?? "unknown",
        outcome: "error",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        successfulProjects: 0,
        failedProjects: 0,
        itemCount: 0,
        ...projectErrorCode(error),
      });
      throw error;
    }
  });
}

function projectErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? { errorCode: String(error.code) }
    : {};
}

function sessionIdentityChanged(
  before: Awaited<ReturnType<TapdAuthenticator["getSession"]>>,
  candidate: TapdIdentity,
) {
  if (!before.identity) {
    return !before.result.ok || before.result.connection.tapd !== "disconnected";
  }
  if (!before.identity.accountKey || !candidate.accountKey) return true;
  return before.identity.accountKey !== candidate.accountKey
    || (before.identity.companyId ?? "") !== (candidate.companyId ?? "");
}

function authFailure(error: unknown, connection: AuthResult["connection"] = {
  tapd: "disconnected",
}): AuthResult {
  if (error instanceof TapdIdentityError
    || error instanceof ProjectSelectionStoreError
    || error instanceof WorkItemCacheError) {
    const errorCode = error instanceof WorkItemCacheError
      ? "cache_clear_failed" as const
      : error.code;
    return { ok: false, errorCode, connection };
  }
  return {
    ok: false,
    errorCode: "credential_store_failed",
    connection,
  };
}

function emptyWorkItemSnapshot(lastSyncAttemptAt: string): WorkItemSyncSnapshot {
  return {
    items: [],
    projects: [],
    summary: { successfulProjects: 0, failedProjects: 0, itemCount: 0 },
    dataFreshness: "live" as const,
    freshScopeCount: 0,
    staleScopeCount: 0,
    lastSyncAttemptAt,
  };
}

function offlineReason(auth: AuthResult) {
  if (auth.connection.tapd === "expired" || auth.errorCode === "invalid_token") {
    return "provider_unauthorized" as const;
  }
  if (auth.errorCode === "tapd_unavailable") return "provider_unavailable" as const;
  return undefined;
}

function cacheOutcome(snapshot: z.infer<typeof taskboardSnapshotSchema>) {
  if (snapshot.cacheWarningCode === "cache_write_failed") return "write_error" as const;
  if (snapshot.dataFreshness === "offline") return "hit" as const;
  if (snapshot.dataFreshness === "mixed") return "write_success" as const;
  if (snapshot.cacheWarningCode) return "miss" as const;
  return snapshot.freshScopeCount === 0 ? "miss" as const : "write_success" as const;
}

function authToolResult(result: Awaited<ReturnType<TapdAuthenticator["login"]>>) {
  return {
    structuredContent: result,
    content: [{
      type: "text" as const,
      text: result.ok
        ? `TAPD ${result.connection.tapd === "connected" ? "已连接" : "已断开"}。`
        : `TAPD 操作失败：${result.errorCode ?? "unknown"}。`,
    }],
  };
}
