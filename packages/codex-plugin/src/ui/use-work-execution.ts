import { useEffect, useRef, useState } from "react";

import { workExecutionHandoffSchema, type WorkExecutionHandoff } from "../contracts/executions.js";
import type { WorkItem } from "../contracts/taskboard.js";
import type { McpAppsBridge } from "./bridge.js";
import { gitLabProjectPageSchema, gitLabProjectSchema, type GitLabProject } from "../contracts/gitlab.js";
import { executionRecordSchema } from "../contracts/executions.js";

export function useWorkExecution(bridge: Pick<McpAppsBridge, "callTool" | "sendUserMessage" | "onToolResult">) {
  const [result, setResult] = useState<WorkExecutionHandoff>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [projects, setProjects] = useState<GitLabProject[]>([]);
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const [repositoryProject, setRepositoryProject] = useState<GitLabProject>();
  const resultRef = useRef<WorkExecutionHandoff | undefined>(undefined);
  const recoverySequence = useRef(0);
  resultRef.current = result;

  useEffect(() => bridge.onToolResult((toolResult) => {
    const execution = executionRecordSchema.safeParse(toolResult.structuredContent);
    const current = resultRef.current;
    if (!execution.success || !current
      || execution.data.executionId !== current.execution.executionId) return;
    const next = { ...current, execution: execution.data };
    resultRef.current = next;
    setResult(next);
    if (execution.data.state === "awaiting_repository") {
      void loadRepositories();
    }
  }), [bridge]);
  async function prepareAndSend(item: WorkItem) {
    setPending(true); setError(undefined);
    try {
      const prepared = result ?? workExecutionHandoffSchema.parse((await bridge.callTool(
        "prepare_work_item_execution",
        { item },
      )).structuredContent);
      setResult(prepared);
      resultRef.current = prepared;
      await bridge.sendUserMessage(prepared.handoff.prompt);
      return prepared;
    } catch (cause) {
      setError(cause instanceof Error && cause.message === "codex_handoff_unsupported"
        ? "当前 Codex 版本不支持直接接管，可使用兼容复制"
        : "未能交给 Codex，请重试");
      return undefined;
    } finally { setPending(false); }
  }
  async function restore(item: WorkItem) {
    const sequence = recoverySequence.current;
    try {
      const response = await bridge.callTool("get_work_item_execution", { workItemKey: item.key });
      const restored = executionRecordSchema.safeParse(
        (response.structuredContent as { execution?: unknown } | undefined)?.execution,
      );
      if (!restored.success || restored.data.workItemKey !== item.key
        || sequence !== recoverySequence.current) return;
      const handoffResponse = await bridge.callTool("prepare_work_item_execution", { item });
      const prepared = workExecutionHandoffSchema.parse(handoffResponse.structuredContent);
      if (sequence !== recoverySequence.current) return;
      setResult(prepared);
      resultRef.current = prepared;
      if (restored.data.state === "awaiting_repository") await loadRepositories();
    } catch {
      // Detail remains usable even if execution recovery is temporarily unavailable.
    }
  }
  function clear() {
    recoverySequence.current += 1;
    resultRef.current = undefined;
    setResult(undefined);
    setError(undefined);
    setRepositoryOpen(false);
    setRepositoryProject(undefined);
  }
  async function loadRepositories() {
    setPending(true); setError(undefined);
    try {
      const response = await bridge.callTool("list_gitlab_projects", { page: 1, perPage: 50 });
      const listed = gitLabProjectPageSchema.parse(response.structuredContent).projects;
      const currentRepository = resultRef.current?.execution.gitlab;
      let currentProject = currentRepository
        ? listed.find((project) => project.projectId === currentRepository.projectId)
        : undefined;
      if (currentRepository && !currentProject) {
        try {
          const projectResponse = await bridge.callTool("get_gitlab_project", {
            projectId: currentRepository.projectId,
          });
          currentProject = gitLabProjectSchema.parse(projectResponse.structuredContent);
        } catch {
          setError("当前关联项目无法读取，请重新选择");
        }
      }
      setProjects(currentProject && !listed.some((project) => project.projectId === currentProject.projectId)
        ? [currentProject, ...listed]
        : listed);
      setRepositoryProject(currentProject);
      setRepositoryOpen(true);
    } catch { setError("无法读取 GitLab 项目，请检查连接"); }
    finally { setPending(false); }
  }
  async function openRepositoryPicker() { await loadRepositories(); }
  async function bindRepository(project: GitLabProject, paths: { localPath?: string; parentDirectory?: string }) {
    if (!result) return;
    setPending(true); setError(undefined);
    try {
      const response = await bridge.callTool("bind_execution_repository", {
        executionId: result.execution.executionId, project, ...paths,
      });
      const execution = executionRecordSchema.parse(response.structuredContent);
      const next = { ...result, execution };
      setResult(next);
      resultRef.current = next;
      setRepositoryOpen(false);
      try {
        await bridge.sendUserMessage(`继续 FlowRivet 执行：${execution.executionId}`);
      } catch {
        setError("仓库已关联，但未能通知 Codex 继续；请重试继续处理");
      }
    } catch { setError("仓库无法关联：请检查路径、remote 和工作树状态"); }
    finally { setPending(false); }
  }
  return { result, pending, error, prepareAndSend, restore, clear, projects, repositoryProject, repositoryOpen, setRepositoryOpen, openRepositoryPicker, bindRepository };
}
