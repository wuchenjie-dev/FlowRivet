import { Check, Copy } from "lucide-react";

import type { WorkExecutionHandoff } from "../../contracts/executions.js";

export function ExecutionSummary({ value, onSelectRepository }: { value: WorkExecutionHandoff; onSelectRepository?: () => void }) {
  return (
    <section className="execution-summary" aria-labelledby="execution-summary-heading">
      <h3 id="execution-summary-heading">Codex 处理任务</h3>
      <p><Check size={14} aria-hidden="true" />已创建可恢复的 handoff</p>
      <dl><div><dt>执行 ID</dt><dd>{value.execution.executionId}</dd></div>
        <div><dt>状态</dt><dd>{value.execution.state}</dd></div></dl>
      <button type="button" onClick={() => void navigator.clipboard?.writeText(value.handoff.prompt)}>
        <Copy size={14} aria-hidden="true" />复制到 Codex
      </button>
      {value.execution.gitlab ? <p>{value.execution.gitlab.projectPath}<br />{value.execution.gitlab.localPath}</p> : onSelectRepository ? <button type="button" onClick={onSelectRepository}>关联研发仓库</button> : null}
    </section>
  );
}
