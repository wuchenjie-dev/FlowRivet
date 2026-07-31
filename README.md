# FlowRivet

FlowRivet 使用 Codex 串联 TAPD、飞书和 GitLab，建立从产品需求、功能规格、研发编码、测试到交付的受控闭环。

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
```

字段初始化默认仅预览。确认目标是沙箱项目后，显式应用：

```powershell
node dist/src/cli.js tapd init-fields --apply
node dist/src/cli.js tapd seed-poc --apply
```

`seed-poc` 默认仅预览，只有 `--apply` 才会创建三条带 `[FLOWRIVET_POC]` 前缀的脱敏需求；重复执行会跳过同名需求。`check-admission` 和 `verify-poc` 是只读命令。门禁通过时退出码为 `0`，门禁阻断时退出码为 `3`，接口或配置错误时退出码为 `1`。

`feishu check-messaging` 是只读权限探测，只返回机器人可访问的群数量，不输出群 ID、群名、成员或 access token。消息发送必须使用显式测试群白名单。

首次使用不依赖浏览器会话。个人 Token 和企业 API 账号只需保存为用户环境变量；重新打开终端或 Codex 后，运行 `doctor` 验证凭据与两个项目的权限边界。若沙箱成员不同，只需修改 `FLOWRIVET_POC_OWNER`，不要把用户名写死在代码中。

完整 PoC 范围、门禁和 E2E 验证矩阵见 [poc.md](./poc.md)。

## 开发验证

```powershell
npm test
npm run typecheck
npm run build
```
