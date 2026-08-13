import { useState } from "react";

import type { ExecutionWorkMode } from "../../contracts/executions.js";

export function ExecutionModeChoice({
  pending,
  onConfirm,
}: {
  pending: boolean;
  onConfirm: (mode: Exclude<ExecutionWorkMode, "pending">) => void;
}) {
  const [mode, setMode] = useState<Exclude<ExecutionWorkMode, "pending">>();
  return (
    <fieldset className="execution-mode-choice" disabled={pending}>
      <legend>选择本次执行方式</legend>
      <label>
        <input
          type="radio"
          name="execution-mode"
          checked={mode === "non_code"}
          onChange={() => setMode("non_code")}
        />
        <span><strong>仅处理当前事项</strong><small>流程梳理、分析、拆解、文档等，不修改代码。</small></span>
      </label>
      <label>
        <input
          type="radio"
          name="execution-mode"
          checked={mode === "code"}
          onChange={() => setMode("code")}
        />
        <span><strong>需要修改代码</strong><small>选择仓库后由 Codex 开发和验证。</small></span>
      </label>
      <button type="button" disabled={!mode || pending} onClick={() => mode && onConfirm(mode)}>
        {pending ? "正在确认..." : "确认执行方式"}
      </button>
    </fieldset>
  );
}
