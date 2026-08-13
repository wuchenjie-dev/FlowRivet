import { useEffect, useRef, useState } from "react";

import { workExecutionHandoffSchema, type WorkExecutionHandoff } from "../contracts/executions.js";
import type { WorkItem } from "../contracts/taskboard.js";
import type { McpAppsBridge } from "./bridge.js";
import { gitLabProjectPageSchema, gitLabProjectSchema, type GitLabProject } from "../contracts/gitlab.js";
import { executionRecordSchema } from "../contracts/executions.js";
import type { ExecutionWorkMode } from "../contracts/executions.js";

export function useWorkExecution(bridge: Pick<McpAppsBridge, "callTool" | "sendUserMessage" | "onToolResult">) {
  const [result, setResult] = useState<WorkExecutionHandoff>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [projects, setProjects] = useState<GitLabProject[]>([]);
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const [repositoryProject, setRepositoryProject] = useState<GitLabProject>();
  const resultRef = useRef<WorkExecutionHandoff | undefined>(undefined);
  const itemRef = useRef<WorkItem | undefined>(undefined);
  const handoffMessageSent = useRef(false);
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
  async function prepare(item: WorkItem) {
    itemRef.current = item;
    setPending(true); setError(undefined);
    try {
      const prepared = result ?? workExecutionHandoffSchema.parse((await bridge.callTool(
        "prepare_work_item_execution",
        { item },
      )).structuredContent);
      setResult(prepared);
      resultRef.current = prepared;
      return prepared;
    } catch (cause) {
      setError(cause instanceof Error && cause.message === "codex_handoff_unsupported"
        ? "当前 Codex 版本不支持直接接管，可使用兼容复制"
        : "未能交给 Codex，请重试");
      return undefined;
    } finally { setPending(false); }
  }
  async function sendAndConfirmHandoff(prepared: WorkExecutionHandoff) {
    let messageSent = false;
    try {
      if (!handoffMessageSent.current) {
        await bridge.sendUserMessage(prepared.handoff.prompt);
        handoffMessageSent.current = true;
      }
      messageSent = handoffMessageSent.current;
      const response = await bridge.callTool("mark_execution_handoff_dispatched", {
        executionId: prepared.execution.executionId,
        handoffId: prepared.handoff.handoffId,
      });
      const execution = executionRecordSchema.parse(response.structuredContent);
      const next = { ...prepared, execution };
      setResult(next);
      resultRef.current = next;
      handoffMessageSent.current = false;
      return next;
    } catch (cause) {
      setError(messageSent
        ? "任务已发送给 Codex，但交接状态未确认；请重试确认"
        : cause instanceof Error && cause.message === "codex_handoff_unsupported"
        ? "当前 Codex 版本不支持直接接管，可使用兼容复制"
        : "未能交给 Codex，请重试");
      return undefined;
    }
  }
  async function chooseMode(item: WorkItem, workMode: Exclude<ExecutionWorkMode, "pending">) {
    const current = resultRef.current ?? await prepare(item);
    if (!current) return undefined;
    setPending(true); setError(undefined);
    try {
      const modeResponse = await bridge.callTool("set_work_item_execution_mode", {
        executionId: current.execution.executionId,
        workMode,
      });
      const execution = executionRecordSchema.parse(modeResponse.structuredContent);
      handoffMessageSent.current = false;
      const prepared = workExecutionHandoffSchema.parse((await bridge.callTool(
        "prepare_work_item_execution",
        { item },
      )).structuredContent);
      const next = { ...prepared, execution };
      setResult(next);
      resultRef.current = next;
      if (execution.state === "awaiting_repository") {
        await loadRepositories();
        return next;
      }
      return await sendAndConfirmHandoff(next);
    } catch {
      setError("无法确认执行方式，请重试");
      return undefined;
    } finally { setPending(false); }
  }
  async function restore(item: WorkItem) {
    itemRef.current = item;
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
    itemRef.current = undefined;
    handoffMessageSent.current = false;
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
    const current = resultRef.current;
    const item = itemRef.current;
    if (!current || !item) return;
    setPending(true); setError(undefined);
    try {
      const response = await bridge.callTool("bind_execution_repository", {
        executionId: current.execution.executionId, project, ...paths,
      });
      const execution = executionRecordSchema.parse(response.structuredContent);
      const prepared = workExecutionHandoffSchema.parse((await bridge.callTool(
        "prepare_work_item_execution",
        { item },
      )).structuredContent);
      const next = { ...prepared, execution };
      setResult(next);
      resultRef.current = next;
      setRepositoryOpen(false);
      await sendAndConfirmHandoff(next);
    } catch { setError("仓库无法关联：请检查路径、remote 和工作树状态"); }
    finally { setPending(false); }
  }
  return { result, pending, error, prepare, chooseMode, sendAndConfirmHandoff, restore, clear, projects, repositoryProject, repositoryOpen, setRepositoryOpen, openRepositoryPicker, bindRepository };
}
