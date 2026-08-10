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

import { createCredentialStore } from "../auth/credential-store.js";
import {
  TapdAuthService,
  type TapdAuthenticator,
} from "../auth/tapd-auth-service.js";
import { TapdIdentityClient } from "../auth/tapd-identity-client.js";
import { authResultSchema } from "../contracts/auth.js";
import { projectCatalogSchema } from "../contracts/projects.js";
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
  JsonProjectSelectionStore,
  resolveFlowRivetConfigDirectory,
} from "../projects/json-project-selection-store.js";
import {
  ProjectCatalogService,
  type ProjectCatalog,
} from "../projects/project-catalog-service.js";
import { ProjectProviderError } from "../projects/project-management-provider.js";
import {
  StoredTapdProjectCredentialResolver,
  TapdProjectProvider,
} from "../projects/tapd-project-provider.js";
import {
  WorkItemService,
  type WorkItemSynchronizer,
} from "../work-items/work-item-service.js";
import { TapdWorkItemProvider } from "../work-items/tapd-work-item-provider.js";
import { TapdWorkItemDetailProvider } from "../work-items/tapd-work-item-detail-provider.js";
import {
  WorkItemDetailService,
  type WorkItemDetailReader,
} from "../work-items/work-item-detail-service.js";
import { WorkItemDetailProviderError } from "../work-items/work-item-detail-provider.js";

export const TASKBOARD_RESOURCE_URI = "ui://flowrivet/taskboard.html";

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
}

export function createTaskboardMcpServer(
  options: TaskboardMcpServerOptions = {},
) {
  const uiBundlePath = options.uiBundlePath ?? DEFAULT_UI_BUNDLE_PATH;
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
  const workItemService = options.workItemService ?? new WorkItemService(
    new TapdWorkItemProvider({ credentialResolver }),
    now,
  );
  const workItemLogger = options.workItemLogger ?? new JsonStderrWorkItemOperationLogger();
  const workItemDetailService = options.workItemDetailService ?? new WorkItemDetailService(
    new TapdWorkItemDetailProvider({ credentialResolver }),
  );
  const workItemDetailLogger = options.workItemDetailLogger
    ?? new JsonStderrWorkItemDetailOperationLogger();
  const server = new McpServer({ name: "flowrivet", version: "0.1.0" });

  registerAppResource(
    server,
    "FlowRivet 我的 TAPD 待办看板",
    TASKBOARD_RESOURCE_URI,
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
            uri: TASKBOARD_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
          },
        ],
      };
    },
  );

  registerWorkItemTool(server, workItemLogger, "open_my_taskboard", {
    title: "打开我的 TAPD 待办看板",
    description: "发现全部可访问项目并打开真实只读待办看板。",
    resourceUri: TASKBOARD_RESOURCE_URI,
    run: buildTaskboardSnapshot,
  });
  registerWorkItemTool(server, workItemLogger, "list_my_work_items", {
    title: "列出我的工作项",
    description: "读取当前用户在全部可访问项目中的真实工作项。",
    run: buildTaskboardSnapshot,
  });
  registerWorkItemTool(server, workItemLogger, "refresh_my_work_items", {
    title: "刷新我的工作项",
    description: "重新发现项目并刷新真实只读工作项。",
    run: buildTaskboardSnapshot,
  });

  registerAppTool(
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
    const auth = await authService.getConnectionStatus();
    const connected = auth.connection.tapd === "connected";
    const catalog = connected ? await projectCatalog.discover() : {
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
      projects: [],
      stale: false,
    };
    const synchronized = connected ? await workItemService.sync({
      accountDisplayName: catalog.provider.accountDisplayName
        ?? auth.connection.userName
        ?? "",
      projects: catalog.projects.filter((project) => project.available),
    }) : {
      items: [],
      projects: [],
      summary: { successfulProjects: 0, failedProjects: 0, itemCount: 0 },
    };
    return taskboardSnapshotSchema.parse({
      projectCatalog: catalog,
      projects: synchronized.projects,
      items: synchronized.items,
      readOnly: true,
      syncSummary: synchronized.summary,
      stages: canonicalStages,
      dataFreshness: "live",
      staleScopeCount: 0,
      lastSuccessfulSyncAt: syncAttemptAt,
      lastSyncAttemptAt: syncAttemptAt,
      lastSyncedAt: syncAttemptAt,
      connection: { ...auth.connection, gitlab: "not_configured" },
    });
  }

  registerAppTool(
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

  registerAppTool(
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
      const before = await authService.getConnectionStatus();
      const result = await authService.login(token);
      if (result.ok && identityChanged(before.connection, result.connection)) {
        await projectCatalog.clear();
      }
      return authToolResult(result);
    },
  );

  registerAppTool(
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
      const result = await authService.disconnect();
      if (result.ok) await projectCatalog.clear();
      return authToolResult(result);
    },
  );

  registerProjectTool(server, projectLogger, projectCatalog, "discover_projects", {
    title: "发现项目",
    description: "从当前项目管理系统发现可访问项目。",
    inputSchema: { providerId: z.string().min(1) },
    run: (catalog) => catalog.discover(),
  });

  registerProjectTool(server, projectLogger, projectCatalog, "save_project_selection", {
    title: "保存项目选择",
    description: "保存当前账号要纳入看板的项目。",
    inputSchema: {
      providerId: z.string().min(1),
      externalIds: z.array(z.string().min(1)),
    },
    run: (catalog, input) => catalog.saveSelection(input.externalIds as string[]),
  });

  registerProjectTool(server, projectLogger, projectCatalog, "add_project", {
    title: "手工添加项目",
    description: "通过项目 ID 或 URL 验证并添加一个项目。",
    inputSchema: {
      providerId: z.string().min(1),
      input: z.string().min(1),
    },
    run: (catalog, input) => catalog.addProject(input.input as string),
  });

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
        providerId: "tapd",
        outcome: snapshot.syncSummary.failedProjects > 0 ? "partial" : "success",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...snapshot.syncSummary,
      });
      return {
        structuredContent: snapshot,
        content: [{
          type: "text" as const,
          text: snapshot.connection.tapd === "connected"
            ? `FlowRivet 看板已同步 ${snapshot.syncSummary.itemCount} 个工作项。`
            : "FlowRivet 看板已打开，请先连接 TAPD。",
        }],
      };
    } catch (error) {
      logger.completed({
        requestId,
        tool,
        providerId: "tapd",
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

function identityChanged(
  before: { tapd: string; userName?: string; companyName?: string },
  after: { tapd: string; userName?: string; companyName?: string },
) {
  if (before.tapd !== "connected" || after.tapd !== "connected") return false;
  return before.userName !== after.userName || before.companyName !== after.companyName;
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
