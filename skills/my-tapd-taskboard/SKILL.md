---
name: my-tapd-taskboard
description: 在 Codex 中打开或刷新 FlowRivet 的“我的 TAPD 待办”只读看板。用户要求查看、筛选或同步真实 TAPD 需求、任务、缺陷，或检查本地 FlowRivet Companion 时使用。
---

# 我的 TAPD 待办看板

## 打开看板

- 用户要求查看、打开或筛选自己的 TAPD 待办时，调用 `open_my_taskboard`。
- 看板自动发现当前账号全部可访问项目，并展示精确分配给当前用户的真实 TAPD 工作项，无需用户选择项目。
- 用户要求重新同步时，调用 `refresh_my_work_items`；查询数据时可以调用 `list_my_work_items`。
- 用户要求检查本地连接时，调用 `demo_ping`。

## 处理异常

- MCP 不可用时，提示用户在 FlowRivet 仓库运行 `npm start --workspace @flowrivet/codex-plugin`。
- 不索取或展示 TAPD、飞书、GitLab 的密钥。
- 看板为只读模式，不宣称已经修改 TAPD，也不调用 TAPD 写接口。
- 如果页面出现“Demo 数据”或可拖动卡片，说明旧 Companion 或旧插件缓存仍在运行；应重新构建、刷新 cachebuster、安装插件并新建 Codex 任务。
