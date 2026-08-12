import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { workExecutionHandoffSchema } from "../../contracts/executions.js";
import { workItemSchema } from "../../contracts/taskboard.js";
import { CodexTaskBridge } from "../../codex/task-bridge.js";
import type { ExecutionService } from "../../executions/execution-service.js";
import { executionRecordSchema } from "../../contracts/executions.js";
import { gitLabProjectSchema } from "../../contracts/gitlab.js";
import type { RepositoryPreparer } from "../../gitlab/repository-workflow.js";
import type { DevelopmentOperations } from "../../gitlab/development-workflow.js";
import { branchForExecution } from "../../gitlab/development-workflow.js";
import type { ConfirmationService } from "../../executions/confirmation-service.js";
import { confirmationChallengeSchema, executionWritebackResultSchema, guardedActionAuthorizationSchema } from "../../contracts/executions.js";
import { ResultWriter } from "../../executions/result-writer.js";
import { WritebackWorkflow, WritebackWorkflowError } from "../../executions/writeback-workflow.js";

export function registerExecutionTools(server: McpServer, options: {
  service: ExecutionService;
  resolveAccountKey: () => Promise<string>;
  bridge?: CodexTaskBridge;
  repositoryWorkflow?: RepositoryPreparer;
  developmentWorkflow?: DevelopmentOperations;
  confirmationService?: ConfirmationService;
  writebackWorkflow?: WritebackWorkflow;
}) {
  const bridge = options.bridge ?? new CodexTaskBridge();
  const resultWriter = new ResultWriter();
  const writebackWorkflow = options.writebackWorkflow ?? new WritebackWorkflow({});
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
  registerAppTool(server, "get_work_item_execution", {
    title: "读取工作项执行",
    description: "恢复当前飞书账号下某个工作项的 FlowRivet 执行状态。",
    inputSchema: { workItemKey: z.string().min(1) },
    outputSchema: { execution: executionRecordSchema.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false }, _meta: {},
  }, async ({ workItemKey }) => {
    const execution = await options.service.get({
      providerId: "feishu-project",
      accountKey: await options.resolveAccountKey(),
      workItemKey,
    });
    return { structuredContent: { ...(execution ? { execution } : {}) }, content: [] };
  });
  registerAppTool(server, "classify_work_item_execution", {
    title: "分类工作项执行",
    description: "由 Codex 将待分类执行确定为需求拆解、需求分析或研发实现。",
    inputSchema: {
      executionId: z.string().min(1),
      executionKind: z.enum(["requirement_breakdown", "requirement_analysis", "development"]),
    },
    outputSchema: executionRecordSchema.shape,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }, _meta: {},
  }, async ({ executionId, executionKind }) => {
    const current = await options.service.getById(executionId);
    if (!current || current.accountKey !== await options.resolveAccountKey()) {
      throw new Error("execution_not_found");
    }
    const execution = await options.service.classify(executionId, executionKind);
    return {
      structuredContent: execution,
      content: execution.state === "awaiting_repository"
        ? [{ type: "text" as const, text: "repository_required" }]
        : [],
    };
  });
  if (options.repositoryWorkflow) registerAppTool(server, "bind_execution_repository", {
    title: "关联研发仓库",
    description: "复用精确匹配的本地仓库，或在用户指定父目录下安全克隆。",
    inputSchema: {
      executionId: z.string().min(1),
      project: gitLabProjectSchema,
      localPath: z.string().min(1).optional(),
      parentDirectory: z.string().min(1).optional(),
    },
    outputSchema: executionRecordSchema.shape,
    annotations: { readOnlyHint: false, openWorldHint: true }, _meta: {},
  }, async ({ executionId, project, localPath, parentDirectory }) => {
    const parsedProject = gitLabProjectSchema.parse(project);
    const prepared = await options.repositoryWorkflow!.prepare({
      project: parsedProject,
      ...(localPath ? { localPath } : {}),
      ...(parentDirectory ? { parentDirectory } : {}),
    });
    const execution = await options.service.bindRepository(executionId, {
      host: parsedProject.host,
      projectId: parsedProject.projectId,
      projectPath: parsedProject.pathWithNamespace,
      localPath: prepared.localPath,
    });
    return { structuredContent: execution, content: [] };
  });
  if (options.developmentWorkflow) {
    const loadDevelopment = async (executionId: string) => {
      const execution = await options.service.getById(executionId);
      if (!execution?.gitlab) throw new Error("execution_repository_required");
      return execution;
    };
    registerAppTool(server, "create_execution_branch", {
      title: "创建研发分支", description: "从所选仓库默认分支创建稳定的 codex 功能分支。",
      inputSchema: { executionId: z.string().min(1), externalId: z.string().min(1), title: z.string().min(1), defaultBranch: z.string().min(1) },
      outputSchema: executionRecordSchema.shape, annotations: { readOnlyHint: false, openWorldHint: true }, _meta: {},
    }, async ({ executionId, externalId, title, defaultBranch }) => {
      const execution = await loadDevelopment(executionId);
      const branch = execution.gitlab!.branch ?? branchForExecution(externalId, title);
      await options.developmentWorkflow!.createBranch({ localPath: execution.gitlab!.localPath, projectPath: execution.gitlab!.projectPath, defaultBranch, branch });
      return { structuredContent: await options.service.updateGitLab(executionId, { branch }), content: [] };
    });
    registerAppTool(server, "push_execution_branch", {
      title: "推送研发分支", description: "推送已关联的 codex 功能分支。",
      inputSchema: { executionId: z.string().min(1), defaultBranch: z.string().min(1) },
      outputSchema: executionRecordSchema.shape, annotations: { readOnlyHint: false, openWorldHint: true }, _meta: {},
    }, async ({ executionId, defaultBranch }) => {
      const execution = await loadDevelopment(executionId); const branch = execution.gitlab!.branch;
      if (!branch) throw new Error("execution_branch_required");
      await options.developmentWorkflow!.push({ localPath: execution.gitlab!.localPath, projectPath: execution.gitlab!.projectPath, branch, defaultBranch });
      return { structuredContent: execution, content: [] };
    });
    registerAppTool(server, "create_execution_merge_request", {
      title: "创建合并请求", description: "幂等创建或恢复当前执行的 GitLab MR。",
      inputSchema: { executionId: z.string().min(1), defaultBranch: z.string().min(1), title: z.string().min(1), description: z.string().max(12_000) },
      outputSchema: executionRecordSchema.shape, annotations: { readOnlyHint: false, openWorldHint: true }, _meta: {},
    }, async ({ executionId, defaultBranch, title, description }) => {
      const execution = await loadDevelopment(executionId); const branch = execution.gitlab!.branch;
      if (!branch) throw new Error("execution_branch_required");
      const mr = await options.developmentWorkflow!.openMergeRequest({ projectPath: execution.gitlab!.projectPath, branch, defaultBranch, title, description });
      return { structuredContent: await options.service.updateGitLab(executionId, { mergeRequestIid: mr.iid, mergeRequestUrl: mr.webUrl }), content: [] };
    });
    registerAppTool(server, "get_execution_pipeline", {
      title: "读取执行流水线", description: "读取当前分支最新 Pipeline。",
      inputSchema: { executionId: z.string().min(1) }, outputSchema: executionRecordSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true }, _meta: {},
    }, async ({ executionId }) => {
      const execution = await loadDevelopment(executionId); const branch = execution.gitlab!.branch;
      if (!branch) throw new Error("execution_branch_required");
      const pipeline = await options.developmentWorkflow!.getPipeline(execution.gitlab!.projectPath, branch);
      return { structuredContent: pipeline ? await options.service.updateGitLab(executionId, { pipelineId: pipeline.id }) : execution, content: [] };
    });
  }
  if (options.confirmationService) {
    const guardedAction = z.enum(["merge_mr", "retry_pipeline", "close_work_item"]);
    registerAppTool(server, "prepare_guarded_action", {
      title: "准备受保护操作", description: "生成五分钟有效、绑定当前用户与目标版本的一次性确认。",
      inputSchema: { operationId: z.string().min(1), action: guardedAction, targetVersion: z.string().min(1), title: z.string().min(1), details: z.array(z.string().min(1)).max(20) },
      outputSchema: confirmationChallengeSchema.shape, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: {},
    }, async ({ operationId, action, targetVersion, title, details }) => ({
      structuredContent: options.confirmationService!.prepare({ operationId, action, actorKey: await options.resolveAccountKey(), targetVersion, summary: { title, details } }), content: [],
    }));
    registerAppTool(server, "confirm_guarded_action", {
      title: "确认受保护操作", description: "消费一次性确认；此工具不接受 confirmed 布尔值，也不直接绕过远端状态复查。",
      inputSchema: { challengeId: z.string().min(1), targetVersion: z.string().min(1) },
      outputSchema: guardedActionAuthorizationSchema.shape, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: {},
    }, async ({ challengeId, targetVersion }) => {
      const challenge = options.confirmationService!.consume({ challengeId, actorKey: await options.resolveAccountKey(), targetVersion });
      return { structuredContent: guardedActionAuthorizationSchema.parse({ authorized: true, operationId: challenge.operationId, action: challenge.action, targetVersion: challenge.targetVersion }), content: [{ type: "text" as const, text: "一次性授权已验证；远端操作尚未执行。" }] };
    });
  }
  registerAppTool(server, "write_execution_result", {
    title: "保存执行结果",
    description: "保存带幂等标记的执行结果；飞书项目不支持写入时明确保留为本地产物。",
    inputSchema: {
      executionId: z.string().min(1), artifactType: z.string().min(1),
      revision: z.number().int().positive(), summary: z.string().min(1).max(6_000),
      pipelineStatus: z.string().min(1).optional(),
    },
    outputSchema: executionWritebackResultSchema.shape,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true }, _meta: {},
  }, async ({ executionId, artifactType, revision, summary, pipelineStatus }) => {
    const current = await options.service.getById(executionId);
    if (!current) throw new Error("execution_not_found");
    const content = resultWriter.build({
      executionId, artifactType, revision, summary,
      ...(current.gitlab?.projectPath ? { repository: current.gitlab.projectPath } : {}),
      ...(current.gitlab?.branch ? { branch: current.gitlab.branch } : {}),
      ...(current.gitlab?.mergeRequestUrl ? { mergeRequestUrl: current.gitlab.mergeRequestUrl } : {}),
      ...(pipelineStatus ? { pipelineStatus } : {}),
    });
    const execution = await options.service.recordArtifact(executionId, {
      artifactId: `${executionId}:${artifactType}:${revision}`,
      type: artifactType, revision, summary: summary.slice(0, 2_000), content,
      uri: `flowrivet://execution/${encodeURIComponent(executionId)}/artifact/${encodeURIComponent(artifactType)}/${revision}`,
    });
    try {
      await writebackWorkflow.write({ executionId, content });
      return { structuredContent: executionWritebackResultSchema.parse({ execution, writeback: { state: "written", content } }), content: [] };
    } catch (error) {
      if (!(error instanceof WritebackWorkflowError)) throw error;
      return {
        structuredContent: executionWritebackResultSchema.parse({ execution, writeback: { state: "local_only", errorCode: error.code, content: error.localArtifact } }),
        content: [{ type: "text" as const, text: "执行结果已保存在 FlowRivet 本地；飞书项目当前不支持自动写回。" }],
      };
    }
  });
}
