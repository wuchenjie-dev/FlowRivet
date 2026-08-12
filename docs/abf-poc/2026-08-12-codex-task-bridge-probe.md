# Codex Task Bridge 合同探针

## 结论

2026-08-12 运行 `npm run probe:codex-task --workspace @flowrivet/codex-plugin`，结果为：

```json
{"ok":true,"capability":"codex_task_bridge","mode":"handoff"}
```

当前 MCP Apps 宿主合同未向 FlowRivet 页面暴露创建、打开和恢复 Codex 任务的完整 API。因此首版必须实现稳定、可恢复的结构化 handoff，由用户显式打开 Codex 任务；不得返回虚假的 `codexTaskId`。

以后若宿主提供正式任务 API，必须同时探测 `createTask`、`openTask` 和 `resumeTask` 后才能切换为 `direct`。
