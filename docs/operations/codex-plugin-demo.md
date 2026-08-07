# Codex 看板 Demo 运行手册

## 范围

本手册用于在 Windows Codex 中注册并验收 FlowRivet Phase 1A 插件。插件已支持使用 TAPD 个人 Token 登录；当前看板中的工作项仍是 Demo 数据，不读取、不修改 TAPD，也不需要配置飞书或 GitLab 凭据。

## 准入标准

- Windows Codex 已安装并可打开插件页。
- Node.js 22 或更高版本，`node --version` 和 `npm --version` 可正常执行。
- 仓库位于本机固定路径，且当前用户可以写入本地 marketplace 目录。
- 本机端口 `43120` 和 `43121` 未被其他程序占用。
- 当前 TAPD 用户可以在 TAPD 的个人设置中创建或查看个人 Token。

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
6. 未连接时，在页面的 `TAPD Token` 密码输入框中输入个人 Token，点击“连接 TAPD”。不要在 Codex 对话、命令参数、配置文件或日志中粘贴 Token。
7. 确认登录成功后输入框被清空，页面进入看板，并显示当前 TAPD 用户和企业。
8. 确认页面自动进入全屏，左侧有项目导航，主区有四列看板。如果宿主拒绝自动全屏，点击右上角“全屏打开看板”按钮重试。
9. 打开连接菜单并检查 Companion，应显示成功状态；点击“断开 TAPD”后，应删除本机凭据并回到登录页。
10. 重新登录后，将一张卡片从“待处理”拖到“进行中”，应提示未写入 TAPD。

固定任务是 Codex 原生任务，不是插件注册的自定义侧边栏菜单。重新安装插件或更新 MCP 工具后需要新建任务；日常重新进入已固定任务时，可以再次输入启动提示打开新的看板实例。

准出标准：插件可发现、MCP 健康检查通过、有效 Token 可登录、无效 Token 有稳定错误提示、断开后凭据被删除、页面非空、四列可见、项目筛选有效、拖动只改变本地 Demo 状态，且日志和页面中没有任何凭据。

## TAPD 凭据与安全边界

- Phase 1A 使用 TAPD 个人 Token，不走 TAPD OAuth，因此不需要 `client_id`、`client_secret`、回调地址或远程服务。
- Token 只通过插件页面提交给本机 Companion。Companion 验证成功后，使用 Windows DPAPI 的 `CurrentUser` 范围加密保存。
- 加密文件位于 `%LOCALAPPDATA%\FlowRivet\tapd-token.json`，只包含密文和格式版本；解密依赖当前 Windows 用户，复制到其他用户或机器不能直接使用。
- 登录失败时输入框立即清空。服务日志、错误消息、MCP 结果和测试产物不得包含 Token、Authorization 请求头或 TAPD 原始响应正文。
- TAPD 返回未授权时，页面显示登录失效，但保留密文以区分临时网络故障；用户可输入新 Token 覆盖，或从连接菜单执行“断开 TAPD”彻底删除本机凭据。
- macOS 和 Linux 已保留凭据存储接口，但 Phase 1A 不会降级为明文文件；在接入 Keychain 或 Secret Service 前会提示当前平台不支持安全存储。

## 浏览器回归

不经过 Codex 也可以验证同一生产 UI 和消息桥：

```powershell
npm run test:e2e --workspace @flowrivet/codex-plugin
```

测试覆盖 1440x900、900x700、Token 登录、未登录、登录失效、断开连接、拖动和键盘可达性。Playwright 默认使用系统 Chrome，测试截图和 trace 写入忽略目录；测试仅使用占位 Token，不访问 TAPD。

## 常见失败

- `43120` 被占用：停止旧 Companion，再重新启动；不要同时运行两个实例。
- `/health` 不可达：确认构建成功且启动命令所在目录是 FlowRivet 仓库。
- 页面提示无法连接宿主：确认从 Codex 插件打开，而不是直接双击生产 HTML。
- UI bundle 缺失：重新执行 workspace 构建并确认 `dist/ui/taskboard.html` 存在。
- 仍看到旧页面：刷新 cachebuster，重新安装插件，并新建 Codex 任务。
- Token 无效或已撤销：在 TAPD 个人设置中确认 Token 状态，回到登录页重新输入；不要通过聊天发送 Token。
- 本机安全存储不可用：确认 Companion 运行在 Windows PowerShell 环境且当前用户可写 `%LOCALAPPDATA%\FlowRivet`。
- 自动全屏失败：使用右上角全屏按钮重试；即使宿主拒绝，全屏失败也不会阻断内嵌看板。
- 插件列表没有 FlowRivet：重新执行 `codex plugin marketplace add`，然后重启 Codex。
- 显示“未能加载插件连接”：使用桌面内置 `$desktopCodex` 执行 `plugin list`；若为 `not installed`，执行 `plugin add flowrivet@flowrivet-local`，不要只注册 marketplace。
- 插件页整体显示“无法加载插件”：API Key 登录模式下，Codex 远程插件目录可能返回 401，因为远程目录要求 ChatGPT 登录。该提示不代表本地 FlowRivet 失败；以 `$desktopCodex plugin list` 的 `installed, enabled` 状态和新任务中 `demo_ping` 的实际结果为准，直接在新任务输入“打开我的 TAPD 待办看板”。

## 后续阶段

真实 TAPD“我的待办”查询、缓存和回写属于后续阶段。Phase 1A 只证明个人 Token 的本地登录、身份验证和安全保存链路，不能用 Demo 工作项代替真实 TAPD 查询验收。
