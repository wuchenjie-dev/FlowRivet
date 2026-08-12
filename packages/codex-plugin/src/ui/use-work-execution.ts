import { useState } from "react";

import { workExecutionHandoffSchema, type WorkExecutionHandoff } from "../contracts/executions.js";
import type { WorkItem } from "../contracts/taskboard.js";
import type { McpAppsBridge } from "./bridge.js";
import { gitLabProjectPageSchema, type GitLabProject } from "../contracts/gitlab.js";
import { executionRecordSchema } from "../contracts/executions.js";

export function useWorkExecution(bridge: Pick<McpAppsBridge, "callTool">) {
  const [result, setResult] = useState<WorkExecutionHandoff>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [projects, setProjects] = useState<GitLabProject[]>([]);
  const [repositoryOpen, setRepositoryOpen] = useState(false);
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
  async function openRepositoryPicker() {
    setPending(true); setError(undefined);
    try {
      const response = await bridge.callTool("list_gitlab_projects", { page: 1, perPage: 100 });
      setProjects(gitLabProjectPageSchema.parse(response.structuredContent).projects);
      setRepositoryOpen(true);
    } catch { setError("无法读取 GitLab 项目，请检查连接"); }
    finally { setPending(false); }
  }
  async function bindRepository(project: GitLabProject, paths: { localPath?: string; parentDirectory?: string }) {
    if (!result) return;
    setPending(true); setError(undefined);
    try {
      const response = await bridge.callTool("bind_execution_repository", {
        executionId: result.execution.executionId, project, ...paths,
      });
      setResult({ ...result, execution: executionRecordSchema.parse(response.structuredContent) });
      setRepositoryOpen(false);
    } catch { setError("仓库无法关联：请检查路径、remote 和工作树状态"); }
    finally { setPending(false); }
  }
  return { result, pending, error, prepare, clear, projects, repositoryOpen, setRepositoryOpen, openRepositoryPicker, bindRepository };
}
