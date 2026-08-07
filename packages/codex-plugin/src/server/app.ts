import { readFile } from "node:fs/promises";
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
import { taskboardSnapshotSchema } from "../contracts/taskboard.js";
import { demoTaskboardSnapshot } from "../demo/fixtures.js";

export const TASKBOARD_RESOURCE_URI = "ui://flowrivet/taskboard.html";

const DEFAULT_UI_BUNDLE_PATH = fileURLToPath(
  new URL("../ui/taskboard.html", import.meta.url),
);

export interface TaskboardMcpServerOptions {
  uiBundlePath?: string;
  now?: () => Date;
  authService?: TapdAuthenticator;
}

export function createTaskboardMcpServer(
  options: TaskboardMcpServerOptions = {},
) {
  const uiBundlePath = options.uiBundlePath ?? DEFAULT_UI_BUNDLE_PATH;
  const now = options.now ?? (() => new Date());
  const authService = options.authService ?? new TapdAuthService({
    store: createCredentialStore(),
    identityClient: new TapdIdentityClient(),
  });
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

  registerAppTool(
    server,
    "open_my_taskboard",
    {
      title: "打开我的 TAPD 待办看板",
      description: "打开 FlowRivet Demo 看板。当前返回模拟数据，不读取 TAPD。",
      inputSchema: {},
      outputSchema: taskboardSnapshotSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: TASKBOARD_RESOURCE_URI } },
    },
    async () => {
      const auth = await authService.getConnectionStatus();
      const connected = auth.connection.tapd === "connected";
      const snapshot = taskboardSnapshotSchema.parse({
        ...(connected ? demoTaskboardSnapshot : {
          projects: [],
          items: [],
          stages: demoTaskboardSnapshot.stages,
          lastSyncedAt: now().toISOString(),
        }),
        connection: {
          ...auth.connection,
          gitlab: "not_configured",
        },
      });
      return {
        structuredContent: snapshot,
        content: [{
          type: "text" as const,
          text: connected
            ? `已打开 FlowRivet Demo 看板，共 ${snapshot.items.length} 个模拟工作项。`
            : "FlowRivet 看板已打开，请先连接 TAPD。",
        }],
      };
    },
  );

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
    async ({ token }) => authToolResult(await authService.login(token)),
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
    async () => authToolResult(await authService.disconnect()),
  );

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
