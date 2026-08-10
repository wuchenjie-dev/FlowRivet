# Codex 看板本地运行手册

## 范围

本手册用于在 Windows Codex 中注册并验收 FlowRivet Phase 1C 插件。Companion 使用本机安全保存的 TAPD 个人 Token，通过 TAPD OpenAPI 自动发现全部可访问项目，并聚合精确分配给当前用户的真实工作项。看板只读，不依赖第三方 TAPD CLI 或 MCP，也不需要配置飞书或 GitLab 凭据。

## 准入标准

- Windows Codex 已安装并可打开插件页。
- Node.js 22.5 或更高版本（本地缓存使用 `node:sqlite`）。
- 当前用户可以写入本地 marketplace 目录。
- 本机端口 `43120` 未被其他程序占用。
- 当前 TAPD 用户具有个人 Token 及目标项目的读取权限。

## 构建与校验

在 FlowRivet 仓库根目录执行：

```powershell
npm install
npm run build --workspace @flowrivet/codex-plugin
& .\scripts\validate-plugin.ps1 -PluginCreatorRoot "$env:USERPROFILE\.codex\skills\.system\plugin-creator"
```

构建产物为 `packages/codex-plugin/dist/ui/taskboard.html`。

## 启动 Companion

保持一个终端运行：

```powershell
npm start --workspace @flowrivet/codex-plugin
```

在另一个终端检查：

```powershell
Invoke-RestMethod http://127.0.0.1:43120/health
```

预期返回 `status` 为 `ok`。Companion 只监听本机回环地址，不应暴露到公网。

## 创建和更新本地插件

首次使用时通过 `plugin-creator` 建立本地 marketplace，并将插件目录联接到 FlowRivet 仓库：
下面的 `$codexCli` 调用等价于 `codex plugin marketplace add` 和 `codex plugin add`，用于兼容桌面应用内置 CLI。

```powershell
$repo = (Resolve-Path .).Path
$marketplaceRoot = Join-Path $env:LOCALAPPDATA "FlowRivetMarketplace"
$pluginCreator = Join-Path $env:USERPROFILE ".codex\skills\.system\plugin-creator"
$marketplaceFile = Join-Path $marketplaceRoot ".agents\plugins\marketplace.json"
$pluginParent = Join-Path $marketplaceRoot "plugins"
$desktopCodex = Join-Path $env:USERPROFILE ".codex\plugins\.plugin-appserver\codex.exe"
$codexCli = if (Test-Path $desktopCodex) { $desktopCodex } else { (Get-Command codex).Source }

python "$pluginCreator\scripts\create_basic_plugin.py" flowrivet `
  --path $pluginParent `
  --marketplace-path $marketplaceFile `
  --marketplace-name flowrivet-local `
  --with-marketplace

$generatedPlugin = Join-Path $pluginParent "flowrivet"
Remove-Item -LiteralPath $generatedPlugin -Recurse
New-Item -ItemType Junction -Path $generatedPlugin -Target $repo
& $codexCli plugin marketplace add $marketplaceRoot
& $codexCli plugin add flowrivet@flowrivet-local
```

每次更新源码后必须刷新版本标识并重新安装：

```powershell
python "$pluginCreator\scripts\update_plugin_cachebuster.py" $repo
& $codexCli plugin add flowrivet@flowrivet-local
& $codexCli plugin list
```

FlowRivet 必须显示为 `installed, enabled`。安装后新建 Codex 任务；已有任务不会重新加载 Skill 和 MCP 工具。Windows 的 PATH 可能指向旧 CLI，因此优先使用桌面应用内置的 `.plugin-appserver\codex.exe`。

## Codex 验收

1. 确认新版 Companion 正在 `43120` 运行。
2. 新建 Codex 任务，并输入 `打开我的 TAPD 待办看板`。
3. 未连接时，在页面密码框输入个人 Token；不要在对话、命令参数、配置或日志中粘贴 Token。
4. 登录后应直接进入看板，自动发现全部可访问项目，无需选择项目。
5. 看板应显示真实工作项及“只读”标识，不应出现“Demo 数据”“管理项目”或拖拽反馈。
6. 点击刷新应调用 `refresh_my_work_items`，重新读取需求、任务和缺陷。
7. 单项目失败时保留其他结果并显示警告；全部失败时显示重试错误，不伪装成空成功。
8. 点击工作项卡片应打开右侧详情抽屉；桌面端不遮住整张看板，移动端使用全屏详情。
9. 详情应展示可用的类型、状态、处理人、创建/更新时间、截止时间和描述；上游缺失的可选字段允许不显示。
10. 详情中的“在 TAPD 中打开”应使用 HTTPS 链接打开原始记录；看板本身不改变 TAPD 状态。
11. 关闭按钮、`Escape`、遮罩点击均可关闭详情，关闭后焦点回到原卡片；详情失败时可在抽屉内重试。
12. 部分范围同步失败时，看板保留失败范围的缓存卡片，并明确显示“部分数据来自缓存”和范围数。
13. Token 失效或网络不可用时，只要存在未过期缓存，看板仍可浏览，并显示离线状态、最后成功同步时间和“重新连接 TAPD”入口。
14. 离线缓存卡片可以打开，但详情仍实时向 TAPD 读取；离线失败时提示“重新连接后加载详情”。

固定任务是 Codex 原生任务，不是插件注册的自定义侧边栏菜单。更新插件后应新建任务，再将新任务固定到侧边栏。

## 数据与安全边界

- Token 由 Windows DPAPI `CurrentUser` 加密保存在 `%LOCALAPPDATA%\FlowRivet\tapd-token.json`，不会写入仓库。
- 工作项摘要缓存使用本机 SQLite，路径分别为：Windows `%LOCALAPPDATA%\FlowRivet\flowrivet.db`、macOS `~/Library/Application Support/FlowRivet/flowrivet.db`、Linux `$XDG_CONFIG_HOME/flowrivet/flowrivet.db`（未设置时为 `~/.config/flowrivet/flowrivet.db`）。
- 缓存按 Provider、稳定账号、租户、项目和工作项类型隔离。每个范围从最后一次成功同步起保留 7 天；恰好 7 天仍有效，超过 7 天才自动删除。一个范围成功同步不会延长其他失败范围的有效期。
- 缓存只保存看板所需的工作项摘要和脱敏命名空间，不保存 Token、账号原始标识、描述、评论、附件或上游响应正文。工作项详情始终实时读取，不做持久化。
- 切换账号前先清除旧账号缓存和项目选择，再提交新 Token；任一步清理失败都保留旧 Token 并返回稳定错误。断开 TAPD 时同样先清缓存和项目选择，成功后才删除 Token。
- Companion 只使用读取接口查询参与项目、需求、任务和缺陷；看板没有 TAPD 写工具。
- 工作项核心模型保持 Provider 中立，TAPD 响应包装只存在于 TAPD Adapter。
- 详情读取必须再次校验项目属于当前 Token 的可访问项目，并校验需求、任务或缺陷的处理人精确匹配当前用户。
- 描述只保留段落、列表、强调、代码和 HTTPS 链接等安全标签；输入超过 256 KiB 时降级为截断的纯文本，不渲染脚本、图片或内联样式。
- 日志只记录 requestId、工具名、Provider、工作项类型、结果、耗时及聚合计数，不记录 Token、身份、项目名、项目 ID、工作项标题、工作项 ID、URL、描述或响应正文。
- 自动发现的新项目直接纳入同步；历史不可访问项目不参与同步。
- 未完成工作项全部保留；已完成项仅保留最近 7 天且具有可信完成时间的记录。

## 真实只读验收

验收输出只记录连接结果、只读标识、项目数量、工作项数量、成功项目数、失败项目数和稳定错误码。不得复制任何上游业务明细。

### 2026-08-07 验收记录

| 检查项 | 结果 |
| --- | --- |
| OpenAPI 请求成功 | `true` |
| 自动项目发现成功 | `true` |
| 真实工作项读取成功 | `true` |
| 看板只读 | `true` |
| TAPD 写操作 | `false` |

### 2026-08-10 详情读取验收记录

| 检查项 | 结果 |
| --- | --- |
| 真实详情读取成功 | `true` |
| 项目访问校验成功 | `true` |
| 工作项类型映射成功 | `true` |
| 状态字段存在 | `true` |
| 处理人字段存在 | `true` |
| HTTPS 原记录链接存在 | `true` |
| 描述字段存在 | `false`（该记录上游未填写，属于合法空值） |
| TAPD 写操作 | `false` |

## 自动化回归

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e --workspace @flowrivet/codex-plugin
```

浏览器测试覆盖桌面和移动端、Token 登录、连接失效、自动项目、真实刷新、部分失败、全部失败、混合/离线缓存、重连焦点恢复、离线详情失败、详情抽屉、会话内详情缓存、并发响应保护、关闭与重试，以及键盘可达性。

### 真实缓存重启探针

准入标准：本机具有有效的 `TAPD_TOKEN`，且目标项目至少有一个工作项类型可读；Node.js 版本不低于 22.5；命令从仓库根目录执行。探针只调用 TAPD 读取接口，并且只允许在系统临时目录创建显式指定的数据库。

Windows PowerShell：

```powershell
$env:TAPD_TOKEN = [Environment]::GetEnvironmentVariable("TAPD_TOKEN", "User")
$probeDb = Join-Path ([IO.Path]::GetTempPath()) ("flowrivet-probe-{0}.db" -f [guid]::NewGuid())
npm run --silent probe:cache --workspace @flowrivet/codex-plugin -- --db $probeDb
Remove-Item Env:TAPD_TOKEN -ErrorAction SilentlyContinue
```

Linux/macOS：

```bash
probe_db="$(mktemp -u "${TMPDIR:-/tmp}/flowrivet-probe-XXXXXX.db")"
npm run --silent probe:cache --workspace @flowrivet/codex-plugin -- --db "$probe_db"
unset TAPD_TOKEN
```

准出标准：进程退出码为 `0`，且只输出以下脱敏结果；探针会在成功或失败后删除数据库及 SQLite 辅助文件。

```json
{"ok":true,"cacheHit":true,"dataFreshness":"offline","scopeCount":2,"requiredFieldsPresent":true}
```

其中 `scopeCount` 是本次至少一个成功同步且被完整恢复的类型范围数，会随项目启用的模块和 Token 权限变化；例如同时开放三个类型时为 `3`。该结果证明第一次实例完成真实只读同步后，第二个全新 Store/Service 实例能从同一临时数据库恢复全部成功范围。失败时只输出 `errorCode`，不输出 Token、路径、身份、项目、工作项或响应内容。

## 常见失败

- 页面出现“Demo 数据”：`43120` 仍是旧 Companion。停止旧进程，从当前仓库重新构建并启动。
- 工具列表没有 `refresh_my_work_items`：插件缓存未更新。刷新 cachebuster，重新执行 `plugin add flowrivet@flowrivet-local`，并新建任务。
- `43120` 被占用：先确认占用者是否为旧 FlowRivet，再停止旧实例并启动当前构建。
- `/health` 不可达：检查构建是否成功以及启动命令的工作目录。
- Token 无效或权限不足：在 TAPD 个人设置确认 Token 状态和读取权限，不要通过聊天发送 Token。
- 看板显示“离线缓存”：当前连接或同步不可用，但本地仍有 7 天内的工作项摘要。可以继续浏览卡片；恢复连接后点击“重新连接 TAPD”并刷新。
- 离线时没有看板数据：当前账号没有可用缓存，或对应范围最后成功同步已超过 7 天；重新连接并完成一次成功同步。
- 断开或切换账号返回 `cache_clear_failed`：本地缓存未能安全删除，因此 Token 保持不变。检查 `%LOCALAPPDATA%\FlowRivet`（或对应平台目录）的写权限后重试，不要手工覆盖 Token 文件。
- 项目或工作项不符合预期：先比较项目数量和工作项数量，不在日志中打印业务明细；确认 TAPD 记录的处理人与当前 Token 身份精确一致。
- 详情显示“无权访问”：当前项目或工作项不在 Token 的授权范围，或处理人已变化；刷新看板后重试。
- 详情显示“不存在”：工作项可能已删除、迁移或不再对当前用户可见；刷新看板以移除旧卡片。
- 详情显示“暂时不可用”或“数据格式异常”：保留抽屉并点击重试；若持续失败，通过 requestId 对照 Companion 脱敏日志排查。
- 插件页显示“无法加载插件”：API Key 登录模式下，远程插件目录可能返回 401。以本地 `plugin list` 的 `installed, enabled` 状态和 MCP 实际调用为准。

Codex 远程插件目录与本地 FlowRivet 是两条链路；远程目录异常不代表本地 Companion 不可用。
