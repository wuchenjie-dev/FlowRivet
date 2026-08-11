# 飞书项目本地授权会话验收记录

## 记录约束

本文只记录平台、版本、场景、结果、耗时范围和稳定错误码。不记录账号、Profile、项目、工作项、授权地址、验证码、设备码、client ID、Token、命令参数或 CLI 原始输出。

## 验收环境

| 日期 | 平台 | Node.js | Meegle CLI | Companion |
| --- | --- | --- | --- | --- |
| 2026-08-11 | Windows | 22.21.1 | 1.0.19 | 本地回环地址 |

## 已完成结果

| 场景 | 验证方式 | 结果 | 耗时范围 | 稳定错误码 |
| --- | --- | --- | --- | --- |
| CLI 登录状态与版本探测 | 真实本机 CLI，只读取脱敏状态 | PASS | 2 秒内 | 无 |
| Companion 健康检查与真实只读同步 | 真实本机 CLI + 本地 MCP，读取三个个人工作范围 | PASS | 10 秒内 | 无 |
| 正常一键授权阶段与自动进入看板 | Demo Harness + Chrome E2E | PASS | 8 秒内 | 无 |
| 授权中刷新插件并接回同一会话 | Demo Harness + Chrome E2E | PASS | 5 秒内 | 无 |
| 系统浏览器失败后的临时手动入口 | Demo Harness + Chrome E2E | PASS | 2 秒内 | `provider_browser_launch_failed` |
| 15 秒长等待、重开与取消入口 | Demo Harness + 虚拟时钟 E2E | PASS | 15 秒边界 | 无 |
| 授权过期停止轮询并提供单一恢复动作 | Demo Harness + Chrome E2E | PASS | 6 秒内 | `provider_login_expired` |
| 缓存看板授权面板关闭与焦点恢复 | Demo Harness + Chrome E2E | PASS | 2 秒内 | 无 |
| Windows、macOS、Linux 固定浏览器命令与 URL 白名单 | 自动化单元测试 | PASS | 1 秒内 | `provider_browser_launch_failed` |
| 非回环地址启动拒绝 | Windows 本机进程烟测 | PASS | 1 秒内 | 固定启动错误 |
| 单元、类型、构建和浏览器回归 | 本地自动化 | PASS | 60 秒内 | 无 |

Chrome E2E 共 25 项，覆盖 390x844、900x700 和 1440x900 视口；页面级横向溢出、控件裁切和非空截图检查均通过。

## 待人工执行

以下场景会改变本机 CLI 登录状态或需要人为操作系统故障注入，本次没有自动执行，不能标记为 PASS：

1. 主动退出当前 CLI 账号，从完全未登录状态点击一次 FlowRivet 连接并在飞书页面点击一次授权。
2. 授权等待期间人工刷新 Codex 插件，并核对服务端脱敏日志中的会话关联标识保持一致。
3. 人为阻止系统默认浏览器启动，确认真实 CLI 会话进入手动降级。
4. 授权过程中切换 CLI Profile，确认旧会话失败且新 Profile 不继承旧会话身份。
5. 授权成功后立即断网，确认凭据保留、同步失败不撤销连接，并可继续浏览未过期缓存。

人工验收时只补充 PASS/FAIL、耗时范围和稳定错误码；不得粘贴浏览器地址、CLI 输出或任何业务数据。
