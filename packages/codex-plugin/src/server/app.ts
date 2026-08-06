import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { taskboardSnapshotSchema } from "../contracts/taskboard.js";
import { demoTaskboardSnapshot } from "../demo/fixtures.js";

export const TASKBOARD_RESOURCE_URI = "ui://flowrivet/taskboard.html";

const DEFAULT_UI_BUNDLE_PATH = fileURLToPath(
  new URL("../ui/taskboard.html", import.meta.url),
);

export interface TaskboardMcpServerOptions {
  uiBundlePath?: string;
  now?: () => Date;
}

export function createTaskboardMcpServer(
  options: TaskboardMcpServerOptions = {},
) {
  const uiBundlePath = options.uiBundlePath ?? DEFAULT_UI_BUNDLE_PATH;
  const now = options.now ?? (() => new Date());
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
    async () => ({
      structuredContent: demoTaskboardSnapshot,
      content: [
        {
          type: "text",
          text: `已打开 FlowRivet Demo 看板，共 ${demoTaskboardSnapshot.items.length} 个模拟工作项。`,
        },
      ],
    }),
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
