import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { workExecutionHandoffSchema } from "../../contracts/executions.js";
import { workItemSchema } from "../../contracts/taskboard.js";
import { CodexTaskBridge } from "../../codex/task-bridge.js";
import type { ExecutionService } from "../../executions/execution-service.js";

export function registerExecutionTools(server: McpServer, options: {
  service: ExecutionService;
  resolveAccountKey: () => Promise<string>;
  bridge?: CodexTaskBridge;
}) {
  const bridge = options.bridge ?? new CodexTaskBridge();
  registerAppTool(server, "prepare_work_item_execution", {
    title: "开始处理工作项",
    description: "为当前飞书账号创建或恢复稳定的 Codex handoff。",
    inputSchema: { item: workItemSchema },
    outputSchema: workExecutionHandoffSchema.shape,
    annotations: { readOnlyHint: false, openWorldHint: false }, _meta: {},
  }, async ({ item }) => {
    const parsedItem = workItemSchema.parse(item);
    if (parsedItem.providerId !== "feishu-project") throw new Error("execution_provider_unsupported");
    const execution = await options.service.prepare({
      providerId: "feishu-project",
      accountKey: await options.resolveAccountKey(),
      workItemKey: parsedItem.key,
      taskLaunchMode: "handoff",
      executionKind: "pending_classification",
    });
    const handoff = bridge.createHandoff(execution, parsedItem);
    const stored = await options.service.attachHandoff(execution.executionId, handoff.handoffId);
    return {
      structuredContent: workExecutionHandoffSchema.parse({ execution: stored, handoff }),
      content: [{ type: "text" as const, text: handoff.prompt }],
    };
  });
}
