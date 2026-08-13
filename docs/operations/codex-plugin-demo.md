# Codex 飞书项目看板本地运行手册

## 范围

FlowRivet 在 Codex 中提供“我的待办”只读看板，默认从飞书项目读取当前账号的真实工作项。Companion 只监听本机回环地址，通过用户本机的 Meegle CLI 会话访问飞书项目。官方飞书项目 MCP 不是必需依赖，终端用户也不需要向 FlowRivet 提交密码或访问凭据。

## 准入标准

- Windows、Linux 或 macOS 已安装 Node.js 22.5 或更高版本。
- 飞书项目 CLI 版本不低于 `1.0.19`。
- Codex 可以安装本地插件，本机端口 `43120` 未被占用。
- 当前飞书账号有权访问目标飞书项目空间和工作项。
- 当前用户可以安装飞书项目 CLI，并允许 CLI 使用系统钥匙串或等价的操作系统安全存储。

## 安装飞书项目 CLI

```powershell
npx -y @lark-project/meegle@latest install
meegle config set host project.feishu.cn
meegle auth status --format json
```

CLI 登录资料留在 CLI 与系统钥匙串中，不写入 FlowRivet 仓库、插件配置或 Codex 对话。`auth status` 未登录时不需要在终端继续操作，直接在看板中点击“连接飞书项目”即可。

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

预期 `status` 为 `ok`，并同时返回 `product`、`pid` 和 `instanceId`。Companion 不应监听公网地址。

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

首次注册完成后，不再手工刷新 cachebuster 或重复执行 `plugin add`。源码更新后在仓库根目录运行：

```powershell
npm run plugin:update
```

该入口先构建最小 CLI，再调用与 `flowrivet plugin update` 相同的更新服务。默认使用当前 checkout；只有显式增加 `--pull` 才会检查干净工作区并执行 `git pull --ff-only`。首次接管没有实例文件的旧版 Companion 时，交互终端会要求确认；无 TTY 或 `--json` 模式使用：

```powershell
npm run plugin:update -- --adopt-legacy-companion --json
```

成功结果包含插件版本、marketplace、Companion PID、实例 ID 和 health 地址，不包含命令输出、业务数据或凭据。更新完成后优先在 Codex 中重新打开 FlowRivet 看板；需要加载新增 MCP 工具时新建任务。只有宿主仍缓存旧资源时才完全退出并重启 Codex。

## 验收流程

1. 确认 Companion 正在 `43120` 运行。
2. 新建 Codex 任务，输入“打开我的待办看板”或“打开我的飞书项目待办”。
3. CLI 缺失时，页面展示安装命令；安装后点击“重新检查飞书项目连接”。
4. 未登录或授权失效时，点击“连接飞书项目”或“重新连接飞书项目”，在飞书页面完成设备授权。
5. FlowRivet 自动打开系统默认浏览器。用户只需在飞书页面点击一次授权，不需要复制验证码或手动检查授权结果。
6. 授权成功后看板自动确认 CLI 账号并调用 `open_my_taskboard`；刷新按钮调用 `refresh_my_work_items`。
7. 看板应显示当前账号的真实工作项、“只读”标识和飞书项目数据来源，不应出现 Demo 数据、Token 输入框、管理项目或拖拽反馈。
8. 点击飞书工作项卡片应打开完整详情，展示状态、优先级、人员、描述和可用时间；详情失败时仍保留基础字段、重试入口和经过校验的 HTTPS 原记录链接。
9. 点击“交给 Codex 处理”应通过 MCP Apps `ui/message` 向当前任务发送一次用户消息；不支持或发送失败时才显示兼容复制入口。
10. Codex 分类为研发实现且缺少仓库时，应打开详情抽屉同级的独立仓库模态框。两种准备方式均显示文件夹图标；“复用本地仓库”选择 Git 仓库，“克隆到父目录”选择父目录。
11. 点击文件夹图标应打开当前操作系统的原生目录选择窗口。选择成功只填入绝对路径，不自动关联；取消保留原输入；选择器不可用时显示可恢复提示且允许手动输入。
12. 关联成功后发送只含执行 ID 的恢复消息。
13. 关联成功后应显示“仓库已关联”。在没有 branch/MR 时点击“修改仓库关联”，当前项目与本地路径必须预选；当前项目不在项目列表首屏时通过数字 projectId 精确恢复。
14. 再次点击文件夹按钮应以当前存在路径为初始目录，等待期间显示“等待系统选择...”，成功后显示“目录已选择”；取消和错误都保留输入。
15. 执行已有 branch 或 MR 后应显示“仓库关联已锁定”。直接调用工具替换项目 ID、项目路径或本地路径均返回 `execution_repository_locked`，完全相同的重试保持幂等。
16. 账号菜单可以断开飞书项目；断开后清除该 Provider 的活跃缓存并返回登录页。
17. 修改一条已在基线中的飞书任务，等待扫描后右上角铃铛应出现未读数；点击通知应打开飞书原任务。

## 授权会话行为

- 正常路径依次显示“正在准备安全授权会话”“请在浏览器中完成飞书授权”“正在确认账号”，成功后自动进入看板。
- 页面每 1.5 秒读取一次非敏感会话快照。刷新插件、关闭缓存看板上的授权面板再重新打开，都能在同一个 Companion 进程中接回当前会话。
- 等待超过 15 秒只更新为“仍在等待飞书确认”，授权仍然有效；可以重新打开授权页或取消，不需要手工检查结果。
- 只有系统浏览器启动失败时，页面才临时显示手动授权链接和备用码。进入成功、失败、过期或取消状态后，这些临时字段立即从服务端会话中清除。
- Companion 重启不会恢复内存中的临时授权会话。重启后先读取 CLI 的真实登录状态：凭据已落地则直接连接，否则重新开始授权。
- 授权成功与首次任务同步相互独立。任务同步失败时仍保持已连接状态，并显示缓存或重试入口。

## 缓存与自动刷新

- 摘要缓存路径为 Windows `%LOCALAPPDATA%\FlowRivet\flowrivet.db`、macOS `~/Library/Application Support/FlowRivet/flowrivet.db`、Linux `$XDG_CONFIG_HOME/flowrivet/flowrivet.db`。
- 缓存按 Provider 和稳定账号隔离，只保存看板摘要；不保存登录资料、描述、评论、附件、上游响应正文或业务 URL。
- 每个范围从最后成功同步起保留 7 天，恰好 7 天仍有效，超过 7 天才自动删除。
- 刷新偏好保存在 `taskboard-preferences.json`。默认 60 秒，可选择不自动刷新、5 秒、10 秒、30 秒、60 秒或自定义 5～3600 秒。
- 页面隐藏时暂停刷新；偏好读取失败时当前会话按不自动刷新处理。多个看板只在 Provider、账号和同步范围一致时合并请求。
- 上游限流时遵循 `Retry-After`；授权失效时暂停自动刷新，完成重新连接飞书项目后恢复。

## 本地工作项通知

- Companion 默认每 60 秒复用共享同步器扫描当前已连接账号；可用 `FLOWRIVET_NOTIFICATION_INTERVAL_SECONDS` 配置 30～3600 秒。
- 首次成功扫描只建立基线。之后检测新分配、状态变化、排期变化、24 小时内到期和已逾期，并按账号与变化指纹去重。
- 通知保存在独立的 `notifications.db`，按 Provider 和稳定账号隔离，已读与未读均保留 30 天后自动清理。
- Windows、macOS 和 Linux 通过原生命令显示系统提醒；原生命令不可用不会回滚事件或停止后台循环。
- 看板通过 `list_work_item_notifications`、`mark_work_item_notification_read` 和 `mark_all_work_item_notifications_read` 管理持久化通知中心。
- 系统弹窗不承诺跨平台点击回调；通知中心先标记已读，再校验 `https://project.feishu.cn` 链接并打开原任务。
- MCP 服务端不能主动唤醒 Codex。对话内提醒需由 Codex Automation 定时调用只读列表工具。

## 安全与日志

- 不在对话、命令参数、仓库、日志或环境文件中传递飞书密码或 CLI 登录资料。
- Companion 只注册只读看板工具与 Provider 连接工具，不调用飞书项目写接口。
- Companion 必须绑定 `127.0.0.1`、`localhost` 或 `::1`；配置其他地址时启动直接失败。
- 日志只记录 requestId、工具、Provider、结果、耗时和聚合计数，不记录身份、项目、工作项、URL、验证码、命令参数、stdout 或 stderr。
- `select_local_directory` 日志只记录 requestId、purpose、platform、outcome、durationMs 和稳定 errorCode；不得记录选择结果、绝对路径或目录内容。
- 飞书详情请求只允许查询当前账号最近一次同步或可用缓存范围中的稳定工作项键，不调用其他 Provider 的详情工具。

## 原生目录选择验收

- Windows：确认只显示系统文件夹窗口，不出现 PowerShell 控制台；重复选择时初始位置为当前存在路径，并且可以向上浏览。选择目录返回成功，点击取消返回取消，Companion 不保留路径日志。
- macOS：确认系统目录选择窗口可选目录、可取消；自动化合同固定使用 `osascript`，不拼接用户输入。
- Linux：优先验收 `zenity`，缺失时验收 `kdialog`；两者都缺失时页面应显示手动输入降级提示。
- 保持系统选择窗口打开时关闭仓库弹窗，晚到结果不得覆盖随后输入或另一种准备方式的路径。
- 检查 `companion.log`：`select_local_directory` 只能记录 requestId、purpose、platform、outcome、durationMs 和稳定 errorCode，不得出现初始路径、选择结果或目录内容。

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
- 授权页面过期：点击“重新授权”创建新会话；正常路径不展示验证码。
- 系统浏览器没有打开：仅在页面出现“打开临时授权页”时使用该入口；不要从日志或 CLI 原始输出复制授权参数。
- 授权完成但看板同步失败：账号连接仍然有效，使用看板刷新按钮重试，不需要重新授权。
- 看板显示离线缓存：当前连接或同步不可用；缓存未超过 7 天时仍可浏览并重新连接飞书项目。
- 工作项为空：先用 `meegle auth status --format json` 验证当前 Profile，再确认飞书项目中工作项确实分配给当前账号。
- 工具列表没有 `start_provider_login`：重新构建、刷新插件 cachebuster、安装插件并新建 Codex 任务。
- 源码更新后页面仍是旧版：在源码根目录运行 `npm run plugin:update`，成功后重启 Codex 并新建任务；单纯刷新页面不会更新插件缓存。
- `plugin_manifest_recovery_conflict`：当前 manifest 与遗留事务的原始、临时哈希都不一致。保留 FlowRivet 用户配置目录中的 `plugin-updates` 备份和日志，先确认手工修改来源，不要直接删除证据或覆盖源码。
- `companion_legacy_confirmation_required`：首次迁移旧 Companion 需要在交互终端确认，或为自动化命令显式增加 `--adopt-legacy-companion`。
- `/health` 不可达：确认端口、构建产物和启动目录。
- 插件页显示“无法加载插件”：远程插件目录与本地 FlowRivet 是两条链路，以 `plugin list` 的 `installed, enabled` 和本地 MCP 调用为准。
