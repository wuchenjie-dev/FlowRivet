# Codex 看板 Demo 运行手册

## 范围

本手册用于在 Windows Codex 中注册并验收 FlowRivet Phase 0 插件。当前看板中的工作项全部是 Demo 数据，不读取、不修改 TAPD，也不需要配置 TAPD、飞书或 GitLab 凭据。

## 准入标准

- Windows Codex 已安装并可打开插件页。
- Node.js 22 或更高版本，`node --version` 和 `npm --version` 可正常执行。
- 仓库位于本机固定路径，且当前用户可以写入本地 marketplace 目录。
- 本机端口 `43120` 和 `43121` 未被其他程序占用。

## 构建与校验

在 FlowRivet 仓库根目录执行：

```powershell
npm install
npm run build --workspace @flowrivet/codex-plugin
& .\scripts\validate-plugin.ps1 -PluginCreatorRoot "$env:USERPROFILE\.codex\skills\.system\plugin-creator"
```

校验脚本应显示插件清单通过。构建产物是 `packages/codex-plugin/dist/ui/taskboard.html`，其中不包含外链脚本。

## 启动 Companion

保持一个终端运行：

```powershell
npm start --workspace @flowrivet/codex-plugin
```

在另一个终端检查：

```powershell
Invoke-RestMethod http://127.0.0.1:43120/health
```

预期返回 `status` 为 `ok`。不要把 Companion 暴露到公网；Phase 0 的 `.mcp.json` 只连接本机回环地址。

## 创建本地 Marketplace

不要手工修改 `marketplace.json` 或 Codex 配置。使用 `plugin-creator` 创建一个独立本地 marketplace，再让其中的插件目录指向 FlowRivet 仓库：

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

这里删除的只是刚生成的空插件骨架，随后用目录联接替换；不会删除 FlowRivet 仓库。首次创建后不再重复执行该段。

更新源码后，用官方脚本刷新缓存标识：

```powershell
python "$pluginCreator\scripts\update_plugin_cachebuster.py" $repo
```

Windows 的 PATH 可能仍指向不含 `plugin add` 的旧 Codex CLI，因此脚本优先调用桌面 Codex 自带的 `.plugin-appserver\codex.exe`。安装完成后执行 `& $codexCli plugin list`，FlowRivet 必须显示为 `installed, enabled`；只有 marketplace 而显示 `not installed` 时，插件连接不会加载。更新后重新执行 `plugin add flowrivet@flowrivet-local` 并新建 Codex 任务，旧任务不会自动重新加载 Skill 和 MCP 工具。

## Codex 验收

1. 确认 Companion 仍在运行。
2. 在 Codex 插件页确认 FlowRivet 已启用。
3. 新建任务，命名为“FlowRivet 待办看板”，工作目录选择 FlowRivet 仓库。
4. 将该任务固定到 Codex 左侧栏，后续将它作为看板的稳定入口。
5. 在任务中输入：`打开我的 TAPD 待办看板`。
6. 确认任务中出现 FlowRivet 页面，随后自动进入全屏，左侧有项目导航，主区有四列看板。
7. 如果宿主拒绝自动全屏，确认页面仍可操作，并点击右上角“全屏打开看板”按钮重试。
8. 打开连接菜单并检查 Companion，应显示成功状态。
9. 将一张卡片从“待处理”拖到“进行中”，应提示未写入 TAPD。

固定任务是 Codex 原生任务，不是插件注册的自定义侧边栏菜单。重新安装插件或更新 MCP 工具后需要新建任务；日常重新进入已固定任务时，可以再次输入启动提示打开新的看板实例。

准出标准：插件可发现、MCP 健康检查通过、页面非空、四列可见、项目筛选有效、拖动只改变本地 Demo 状态，且日志和页面中没有任何凭据。

## 浏览器回归

不经过 Codex 也可以验证同一生产 UI 和消息桥：

```powershell
npm run test:e2e --workspace @flowrivet/codex-plugin
```

测试覆盖 1440x900、900x700、未登录、登录失效、拖动和键盘可达性。Playwright 默认使用系统 Chrome，测试截图和 trace 写入忽略目录。

## 常见失败

- `43120` 被占用：停止旧 Companion，再重新启动；不要同时运行两个实例。
- `/health` 不可达：确认构建成功且启动命令所在目录是 FlowRivet 仓库。
- 页面提示无法连接宿主：确认从 Codex 插件打开，而不是直接双击生产 HTML。
- UI bundle 缺失：重新执行 workspace 构建并确认 `dist/ui/taskboard.html` 存在。
- 仍看到旧页面：刷新 cachebuster，重新安装插件，并新建 Codex 任务。
- 自动全屏失败：使用右上角全屏按钮重试；即使宿主拒绝，全屏失败也不会阻断内嵌看板。
- 插件列表没有 FlowRivet：重新执行 `codex plugin marketplace add`，然后重启 Codex。
- 显示“未能加载插件连接”：使用桌面内置 `$desktopCodex` 执行 `plugin list`；若为 `not installed`，执行 `plugin add flowrivet@flowrivet-local`，不要只注册 marketplace。
- 插件页整体显示“无法加载插件”：API Key 登录模式下，Codex 远程插件目录可能返回 401，因为远程目录要求 ChatGPT 登录。该提示不代表本地 FlowRivet 失败；以 `$desktopCodex plugin list` 的 `installed, enabled` 状态和新任务中 `demo_ping` 的实际结果为准，直接在新任务输入“打开我的 TAPD 待办看板”。

## 后续阶段

真实 TAPD 登录、我的待办查询、缓存和回写属于 Phase 1。接入前必须增加 OAuth、权限边界、请求日志与 requestId、真实 API 合同测试和端到端测试，不能用 Phase 0 Demo 结果代替。
