import { useState } from "react";

import { workExecutionHandoffSchema, type WorkExecutionHandoff } from "../contracts/executions.js";
import type { WorkItem } from "../contracts/taskboard.js";
import type { McpAppsBridge } from "./bridge.js";

export function useWorkExecution(bridge: Pick<McpAppsBridge, "callTool">) {
  const [result, setResult] = useState<WorkExecutionHandoff>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function prepare(item: WorkItem) {
    setPending(true); setError(undefined);
    try {
      const response = await bridge.callTool("prepare_work_item_execution", { item });
      const parsed = workExecutionHandoffSchema.parse(response.structuredContent);
      setResult(parsed);
      return parsed;
    } catch {
      setError("无法创建 Codex 处理任务，请稍后重试");
      return undefined;
    } finally { setPending(false); }
  }
  function clear() { setResult(undefined); setError(undefined); }
  return { result, pending, error, prepare, clear };
}
