# Codex 飞书项目看板本地运行手册

## 范围

FlowRivet 在 Codex 中提供“我的待办”只读看板，默认从飞书项目读取当前账号的真实工作项。Companion 只监听本机回环地址，通过用户本机的 Meegle CLI 会话访问飞书项目。官方飞书项目 MCP 不是必需依赖，终端用户也不需要向 FlowRivet 提交密码或访问凭据。

## 准入标准

- Windows、Linux 或 macOS 已安装 Node.js 22.5 或更高版本。
- Codex 可以安装本地插件，本机端口 `43120` 未被占用。
- 当前飞书账号有权访问目标飞书项目空间和工作项。
- 当前用户可以安装飞书项目 CLI，并允许 CLI 使用系统钥匙串或等价的操作系统安全存储。

## 安装飞书项目 CLI

```powershell
npx -y @lark-project/meegle@latest install
meegle config set host project.feishu.cn
meegle auth login --device-code
meegle auth status --format json
```

设备授权在飞书页面完成。CLI 登录资料留在 CLI 与系统钥匙串中，不写入 FlowRivet 仓库、插件配置或 Codex 对话。也可以跳过命令行登录，在看板中点击“连接飞书项目”，按页面显示的 URL 和临时验证码完成授权。

## 构建与启动 Companion

在仓库根目录运行：

```powershell
npm install
npm run build --workspace @flowrivet/codex-plugin
npm start --workspace @flowrivet/codex-plugin
```

另开终端检查：

```powershell
Invoke-RestMethod http://127.0.0.1:43120/health
```

预期 `status` 为 `ok`。Companion 不应监听公网地址。

## 注册本地插件

下面使用 Codex 桌面应用内置 CLI；它等价于 `codex plugin marketplace add` 和 `codex plugin add`。API Key 模式下远程插件目录可能不可用，但不影响本地 marketplace。

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

源码更新后刷新 cachebuster、重新执行 `plugin add flowrivet@flowrivet-local`，并新建 Codex 任务。已有任务不会重新加载 Skill 和 MCP 工具。

## 验收流程

1. 确认 Companion 正在 `43120` 运行。
2. 新建 Codex 任务，输入“打开我的待办看板”或“打开我的飞书项目待办”。
3. CLI 缺失时，页面展示安装命令；安装后点击“重新检查飞书项目连接”。
4. 未登录或授权失效时，点击“连接飞书项目”或“重新连接飞书项目”，在飞书页面完成设备授权。
5. 授权成功后看板自动调用 `open_my_taskboard`，刷新按钮调用 `refresh_my_work_items`。
6. 看板应显示当前账号的真实工作项、“只读”标识和飞书项目数据来源，不应出现 Demo 数据、Token 输入框、管理项目或拖拽反馈。
7. 点击飞书工作项卡片应使用 `noopener,noreferrer` 打开经过校验的 HTTPS 原记录链接。
8. 账号菜单可以断开飞书项目；断开后清除该 Provider 的活跃缓存并返回登录页。

## 缓存与自动刷新

- 摘要缓存路径为 Windows `%LOCALAPPDATA%\FlowRivet\flowrivet.db`、macOS `~/Library/Application Support/FlowRivet/flowrivet.db`、Linux `$XDG_CONFIG_HOME/flowrivet/flowrivet.db`。
- 缓存按 Provider 和稳定账号隔离，只保存看板摘要；不保存登录资料、描述、评论、附件、上游响应正文或业务 URL。
- 每个范围从最后成功同步起保留 7 天，恰好 7 天仍有效，超过 7 天才自动删除。
- 刷新偏好保存在 `taskboard-preferences.json`。默认 60 秒，可选择不自动刷新、5 秒、10 秒、30 秒、60 秒或自定义 5～3600 秒。
- 页面隐藏时暂停刷新；偏好读取失败时当前会话按不自动刷新处理。多个看板只在 Provider、账号和同步范围一致时合并请求。
- 上游限流时遵循 `Retry-After`；授权失效时暂停自动刷新，完成重新连接飞书项目后恢复。

## 安全与日志

- 不在对话、命令参数、仓库、日志或环境文件中传递飞书密码或 CLI 登录资料。
- Companion 只注册只读看板工具与 Provider 连接工具，不调用飞书项目写接口。
- 日志只记录 requestId、工具、Provider、结果、耗时和聚合计数，不记录身份、项目、工作项、URL、验证码、命令参数、stdout 或 stderr。
- 飞书工作项没有详情能力时直接打开 HTTPS 原记录，不调用其他 Provider 的详情工具。

## 自动化验证

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e --workspace @flowrivet/codex-plugin
```

历史 TAPD 缓存探针仍可通过 `npm run probe:cache --workspace @flowrivet/codex-plugin` 单独验证；成功结果只包含 `requiredFieldsPresent` 等脱敏聚合字段。本次飞书项目默认路径不依赖该探针。

## 常见问题

- `cli_missing`：运行安装命令并重新检查；不要改为手工粘贴登录资料。
- 授权页面过期：取消当前授权，重新点击连接生成新的临时验证码。
- 看板显示离线缓存：当前连接或同步不可用；缓存未超过 7 天时仍可浏览并重新连接飞书项目。
- 工作项为空：先用 `meegle auth status --format json` 验证当前 Profile，再确认飞书项目中工作项确实分配给当前账号。
- 工具列表没有 `start_provider_login`：重新构建、刷新插件 cachebuster、安装插件并新建 Codex 任务。
- `/health` 不可达：确认端口、构建产物和启动目录。
- 插件页显示“无法加载插件”：远程插件目录与本地 FlowRivet 是两条链路，以 `plugin list` 的 `installed, enabled` 和本地 MCP 调用为准。
