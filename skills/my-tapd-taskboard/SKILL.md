---
name: my-tapd-taskboard
description: 在 Codex 中打开并操作 FlowRivet 的“我的 TAPD 待办”看板。用户要求查看、打开、筛选或演示 TAPD 待办/任务看板，或检查本地 FlowRivet Companion 时使用。
---

# 我的 TAPD 待办看板

## 打开看板

- 用户要求查看、打开或筛选自己的 TAPD 待办时，调用 `open_my_taskboard`。
- Phase 0 返回演示数据。明确说明这些任务尚未与真实 TAPD 同步。
- 用户要求检查本地连接时，调用 `demo_ping`。

## 处理异常

- MCP 不可用时，提示用户在 FlowRivet 仓库运行 `npm start --workspace @flowrivet/codex-plugin`。
- 不索取或展示 TAPD、飞书、GitLab 的密钥。
- 不宣称已经修改 TAPD。Phase 0 的拖动只在看板本地模拟状态变化。
