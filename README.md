# FlowRivet

FlowRivet 使用 Codex 串联 TAPD、飞书和 GitLab，建立从产品需求、功能规格、研发编码、测试到交付的受控闭环。

FlowRivet 自身可以托管在 GitHub，但受管业务项目的代码事实源是内网 GitLab。GitLab 仓库及项目映射必须来自 TAPD 项目配置和源码关联数据，不能从 FlowRivet 本地仓库的 `origin` 推断，也不在插件中重复保存。

当前 PoC 已实现：

- TAPD 个人 Token 与企业 API 账号的双凭证配置。
- 源项目只读、沙箱项目写入的环境隔离。
- `doctor` 权限和配置检查。
- 14 个需求字段的 dry-run、幂等初始化和漂移阻断。
- TAPD 需求分页读取和项目级动态字段映射。
- 用户 VOC 与技术、质量、安全等替代证据的准入门禁。
- 三类脱敏 ABF 需求的批量 PoC 评估。
- 飞书自建应用鉴权检查，结果不暴露 access token。

## 环境要求

- Node.js 22 或更高版本。
- TAPD 个人 Token，用于读取源项目。
- TAPD 企业 API 账号，用于初始化已授权的沙箱项目。

不要把任何凭证写入 `.env` 后提交到 Git。推荐设置为 Windows 用户环境变量。

```powershell
$token = Read-Host "TAPD 个人 Token"
$apiUser = Read-Host "TAPD API 账号"
$apiPassword = Read-Host "TAPD API 口令"
$feishuSecret = Read-Host "飞书 App Secret"

[Environment]::SetEnvironmentVariable("TAPD_TOKEN", $token, "User")
[Environment]::SetEnvironmentVariable("TAPD_API_USER", $apiUser, "User")
[Environment]::SetEnvironmentVariable("TAPD_API_PASSWORD", $apiPassword, "User")
[Environment]::SetEnvironmentVariable("TAPD_API_ENDPOINT", "https://api.tapd.cn", "User")
[Environment]::SetEnvironmentVariable("TAPD_SOURCE_WORKSPACE_ID", "56536239", "User")
[Environment]::SetEnvironmentVariable("TAPD_SANDBOX_WORKSPACE_ID", "50396062", "User")
[Environment]::SetEnvironmentVariable("FLOWRIVET_POC_OWNER", "你的TAPD用户名", "User")
[Environment]::SetEnvironmentVariable("FEISHU_APP_ID", "你的飞书App ID", "User")
[Environment]::SetEnvironmentVariable("FEISHU_APP_SECRET", $feishuSecret, "User")
[Environment]::SetEnvironmentVariable("FEISHU_TEST_CHAT_ID", "测试群chat_id", "User")
[Environment]::SetEnvironmentVariable("FEISHU_POC_USER_OPEN_ID", "飞书Open ID", "User")
[Environment]::SetEnvironmentVariable("FLOWRIVET_POC_TAPD_USER", "TAPD用户名", "User")
```

以上用户环境变量仅用于本地 POC。正式插件不得要求终端用户持有企业 API 密码或飞书 App Secret；这些凭据应由远程 FlowRivet MCP 从 Secret Manager 注入，Codex 只连接带身份认证和审计的 MCP 服务。详见 [凭据安全架构](./docs/architecture/credential-boundary.md)。

## 使用

```powershell
npm install
npm run build
node dist/src/cli.js doctor
node dist/src/cli.js tapd init-fields
node dist/src/cli.js tapd check-admission <requirement-id>
node dist/src/cli.js tapd seed-poc
node dist/src/cli.js tapd verify-poc
node dist/src/cli.js feishu check-messaging
node dist/src/cli.js feishu send-poc-card
node dist/src/cli.js feishu send-blocker-reminder
node dist/src/cli.js tapd record-blocker-reminder
node dist/src/cli.js tapd check-code-trace <requirement-id>
node dist/src/cli.js feishu verify-identity
node dist/src/cli.js feishu preview-blocker-reminder
```

字段初始化默认仅预览。确认目标是沙箱项目后，显式应用：

```powershell
node dist/src/cli.js tapd init-fields --apply
node dist/src/cli.js tapd seed-poc --apply
```

`seed-poc` 默认仅预览，只有 `--apply` 才会创建三条带 `[FLOWRIVET_POC]` 前缀的脱敏需求；重复执行会跳过同名需求。`check-admission` 和 `verify-poc` 是只读命令。门禁通过时退出码为 `0`，门禁阻断时退出码为 `3`，接口或配置错误时退出码为 `1`。

`feishu check-messaging` 是只读权限探测，只返回机器人可访问的群数量，不输出群 ID、群名、成员或 access token。消息发送必须使用显式测试群白名单。

`feishu send-poc-card` 默认仅生成预览；确认白名单群后使用 `--apply` 发送。请求携带稳定 `uuid`，重复执行不会在飞书的一小时幂等窗口内产生重复消息。

`feishu send-blocker-reminder` 会实时读取 TAPD 沙箱中的阻塞需求，执行准入检查并通过显式身份绑定生成 `@责任人` 卡片。默认仅返回脱敏预览；人工确认后增加 `--apply` 才会发送。幂等键由需求 ID 和当前阻塞项生成，同一阻塞状态重复执行不会产生重复提醒，阻塞项变化后可发送新提醒。

飞书提醒确认送达后，使用 `tapd record-blocker-reminder` 预览回写结果，确认后增加 `--apply` 在原需求下创建结构化评论。命令会先读取已有评论，并按“需求 ID + 阻塞项”标记去重；重复执行不会重复留痕。评论不包含飞书 Open ID、群 ID 或应用密钥。

`tapd check-code-trace <requirement-id>` 通过 TAPD 源码关系接口检查需求关联的 Git Commit。输出仅包含关联数量、仓库数量和 SCM 类型，不输出内网仓库 URL、分支名或 Commit SHA。没有关联时以门禁退出码 `3` 返回。

本地验证时将 `TAPD_TOKEN`、企业 API 凭据、`FEISHU_APP_SECRET` 等写入用户级环境变量；远程部署时应只配置在 MCP 服务端的密钥管理或运行时 Secret 中，不进入插件包、仓库、日志或 Codex 对话。插件用户只需配置服务地址并完成身份绑定。

`feishu verify-identity` 只接受显式 TAPD 用户名和飞书 `ou_...` Open ID，不按姓名推断，也不在输出中显示 Open ID。

`feishu preview-blocker-reminder` 从 TAPD 沙箱回读阻断需求，重新运行门禁并校验负责人绑定，仅生成定向提醒预览。负责人没有显式绑定或需求已经通过时安全失败。

首次使用不依赖浏览器会话。个人 Token 和企业 API 账号只需保存为用户环境变量；重新打开终端或 Codex 后，运行 `doctor` 验证凭据与两个项目的权限边界。若沙箱成员不同，只需修改 `FLOWRIVET_POC_OWNER`，不要把用户名写死在代码中。

完整 PoC 范围、门禁和 E2E 验证矩阵见 [poc.md](./poc.md)。

## 开发验证

```powershell
npm test
npm run typecheck
npm run build
```
