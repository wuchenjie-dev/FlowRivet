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

## 环境要求

- Node.js 22 或更高版本。
- TAPD 个人 Token，用于读取源项目。
- TAPD 企业 API 账号，用于初始化已授权的沙箱项目。

不要把任何凭证写入 `.env` 后提交到 Git。推荐设置为 Windows 用户环境变量。

```powershell
$token = Read-Host "TAPD 个人 Token"
$apiUser = Read-Host "TAPD API 账号"
$apiPassword = Read-Host "TAPD API 口令"

[Environment]::SetEnvironmentVariable("TAPD_TOKEN", $token, "User")
[Environment]::SetEnvironmentVariable("TAPD_API_USER", $apiUser, "User")
[Environment]::SetEnvironmentVariable("TAPD_API_PASSWORD", $apiPassword, "User")
[Environment]::SetEnvironmentVariable("TAPD_API_ENDPOINT", "https://api.tapd.cn", "User")
[Environment]::SetEnvironmentVariable("TAPD_SOURCE_WORKSPACE_ID", "56536239", "User")
[Environment]::SetEnvironmentVariable("TAPD_SANDBOX_WORKSPACE_ID", "50396062", "User")
```

## 使用

```powershell
npm install
npm run build
node dist/src/cli.js doctor
node dist/src/cli.js tapd init-fields
node dist/src/cli.js tapd check-admission <requirement-id>
```

字段初始化默认仅预览。确认目标是沙箱项目后，显式应用：

```powershell
node dist/src/cli.js tapd init-fields --apply
```

`check-admission` 是只读命令。门禁通过时退出码为 `0`，门禁阻断时退出码为 `3`，接口或配置错误时退出码为 `1`。

完整 PoC 范围、门禁和 E2E 验证矩阵见 [poc.md](./poc.md)。

## 开发验证

```powershell
npm test
npm run typecheck
npm run build
```
