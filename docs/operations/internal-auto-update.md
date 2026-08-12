# FlowRivet 内部自动更新运维手册

## 适用范围

FlowRivet Companion、MCP 看板 UI 和更新器通过企业内部 GitLab Generic Package Registry 发布。普通用户安装一次后，不需要 Git、系统 Node.js 或源码目录。

## 管理员准备

1. 在自建 GitLab 为 FlowRivet 启用 Generic Package Registry，并配置受保护的 `v*` 标签。
2. 为 Windows x64、Linux x64、macOS arm64 准备受保护 Runner。
3. 把 Node 22 运行时放入企业内网镜像，将文件名、来源和 SHA-256 写入 `scripts/release/runtime-checksums.json`。不得在终端机器下载 Node。
4. 为 CI 设置 `FLOWRIVET_NODE_RUNTIME_ARCHIVE`。发布任务仅使用 `CI_JOB_TOKEN` 上传。
5. 验证不可变版本包拒绝重复上传；只允许 `flowrivet-channel/latest/manifest.json` 更新。

## 普通用户安装

Windows 管理员提供签名后的 `install-flowrivet.ps1`、GitLab HTTPS 地址、项目 ID 和首个版本：

```powershell
.\install-flowrivet.ps1 -GitLabBaseUrl https://gitlab.example -ProjectId 123 -Version 1.0.0
```

macOS/Linux：

```sh
FLOWRIVET_GITLAB_BASE_URL=https://gitlab.example \
FLOWRIVET_PROJECT_ID=123 FLOWRIVET_VERSION=1.0.0 \
sh ./install-flowrivet.sh
```

安装器会安全提示 Deploy Token。令牌不写入配置文件、不出现在命令参数中；更新器将其写入 Windows 凭据库、macOS Keychain 或 Linux Secret Service。Deploy Token 只授予 `read_package_registry`。

## 更新与回滚

更新器登录后启动，随后约每 30 分钟检查一次稳定频道。新包只有在清单一致、协议兼容、SHA-256、大小、归档布局和 Companion 健康检查全部通过后才激活。候选版本失败时自动恢复上一版本，并对失败版本进入冷却。

已打开的看板不会被强制刷新。看板显示“新版已就绪”后，在 Codex 对话中执行 `重新打开 FlowRivet 看板`。若宿主仍缓存旧 UI，再重启 Codex。

## 诊断

日志只记录 requestId、阶段、版本、平台、耗时、结果和稳定错误码。严禁收集 Deploy Token、授权头、用户身份、工作项正文或 Registry 响应体。

常见错误：

- `credential_store_unavailable`：系统安全存储不可用。
- `runtime_checksum_untrusted`：CI 的 Node 运行时不在固定校验表。
- `candidate_activation_failed`：候选 Companion 未通过健康检查，已回滚。
- `companion_ownership_unverified`：实例文件、PID、启动时间或健康身份不一致，更新器拒绝停止进程。

## 凭据轮换

创建新的只读 Deploy Token，通过更新器配置流程验证其能读取频道清单，再删除旧凭据引用并在 GitLab 撤销旧 Token。不要通过聊天、日志或命令行参数传递 Token。

## 发布前人工 POC

必须在目标自建 GitLab 和三种真实操作系统上完成清单中的验收。仓库不得记录内部响应体、人员身份、业务任务或任何 Token，仅记录 GitLab/Codex 版本和布尔结果。
