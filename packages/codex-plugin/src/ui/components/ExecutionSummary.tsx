import { Check, Copy, ExternalLink, LockKeyhole } from "lucide-react";

import type { WorkExecutionHandoff } from "../../contracts/executions.js";

export function ExecutionSummary({
  value,
  onSelectRepository,
  allowCompatibilityCopy = false,
}: {
  value: WorkExecutionHandoff;
  onSelectRepository?: () => void;
  allowCompatibilityCopy?: boolean;
}) {
  const gitlab = value.execution.gitlab;
  const repositoryLocked = Boolean(gitlab?.branch || gitlab?.mergeRequestIid);
  const mergeRequestUrl = safeGitLabUrl(gitlab?.mergeRequestUrl);
  return (
    <section className="execution-summary" aria-labelledby="execution-summary-heading">
      <h3 id="execution-summary-heading">Codex 处理任务</h3>
      <p role="status"><Check size={14} aria-hidden="true" />{gitlab ? "仓库已关联" : "已创建可恢复的 Codex 执行"}</p>
      <dl>
        <div><dt>执行 ID</dt><dd>{value.execution.executionId}</dd></div>
        <div><dt>任务类型</dt><dd>{kindLabel(value.execution.executionKind)}</dd></div>
        <div><dt>状态</dt><dd>{stateLabel(value.execution.state)}</dd></div>
        {gitlab ? <>
          <div><dt>仓库</dt><dd>{gitlab.projectPath}</dd></div>
          <div><dt>本地路径</dt><dd>{gitlab.localPath}</dd></div>
          {gitlab.branch ? <div><dt>分支</dt><dd>{gitlab.branch}</dd></div> : null}
          {gitlab.pipelineId ? <div><dt>流水线</dt><dd>#{gitlab.pipelineId}</dd></div> : null}
          {mergeRequestUrl ? <div><dt>合并请求</dt><dd><a href={mergeRequestUrl} target="_blank" rel="noreferrer">查看 MR <ExternalLink size={12} aria-hidden="true" /></a></dd></div> : null}
        </> : null}
        {value.execution.state === "writeback_pending" ? <div><dt>飞书回写</dt><dd>尚未写回，结果已保存在本地</dd></div> : null}
      </dl>
      {allowCompatibilityCopy ? (
        <button type="button" onClick={() => void navigator.clipboard?.writeText(value.handoff.prompt)}>
          <Copy size={14} aria-hidden="true" />兼容复制到 Codex
        </button>
      ) : null}
      {onSelectRepository ? gitlab ? (
        <div className="execution-repository-action">
          <button type="button" disabled={repositoryLocked} onClick={onSelectRepository}>
            {repositoryLocked ? <><LockKeyhole size={14} aria-hidden="true" />仓库关联已锁定</> : "修改仓库关联"}
          </button>
          {repositoryLocked ? <small>已创建研发分支，仓库关联不可修改</small> : null}
        </div>
      ) : <button type="button" onClick={onSelectRepository}>关联研发仓库</button> : null}
    </section>
  );
}

function safeGitLabUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "gitlab-aiabu.ruijie.com.cn" ? value : undefined;
  } catch { return undefined; }
}

function kindLabel(kind: WorkExecutionHandoff["execution"]["executionKind"]) {
  return { pending_classification: "待 Codex 判断", requirement_breakdown: "需求拆解", requirement_analysis: "需求分析", development: "研发实现" }[kind];
}

function stateLabel(state: WorkExecutionHandoff["execution"]["state"]) {
  return {
    prepared: "已准备", awaiting_repository: "等待选择仓库", ready: "可开始", running: "处理中",
    awaiting_confirmation: "等待确认", writeback_pending: "等待飞书写回", completed: "已完成", failed: "处理失败",
  }[state];
}
