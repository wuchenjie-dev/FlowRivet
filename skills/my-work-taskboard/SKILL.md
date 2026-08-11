---
name: my-work-taskboard
description: Use when the user asks to open, view, refresh, filter, or connect their FlowRivet work taskboard, especially for Feishu Project personal work items.
---

# 我的待办看板

## 打开与刷新

- 打开或查看待办时调用 `open_my_taskboard`。
- 用户明确要求刷新时调用 `refresh_my_work_items`；仅需结构化数据时调用 `list_my_work_items`。
- 看板为只读，不宣称已修改飞书项目或其他项目管理系统。

## 飞书项目连接

1. 调用 `get_provider_connection` 检查连接。
2. `cli_missing` 时提示用户在本机运行 `npx -y @lark-project/meegle@latest install`，随后再次检查。
3. `disconnected` 或 `expired` 时调用 `start_provider_login`，让用户按页面中的 URL 和临时验证码完成飞书设备授权。
4. 授权后再次调用 `get_provider_connection`；已连接再打开看板。
5. 用户取消授权时调用 `cancel_provider_login`，主动退出时调用 `disconnect_provider`。

## 安全边界

- 不索取飞书密码、Meegle 凭据、TAPD 凭据或 GitLab 凭据。
- 飞书项目 CLI 的登录资料由 CLI 与操作系统安全存储管理。
- 官方飞书项目 MCP 不是必需依赖；FlowRivet 通过本机 Companion 调用 CLI。
- MCP 不可用时，提示在 FlowRivet 仓库运行 `npm start --workspace @flowrivet/codex-plugin`。
