# FlowRivet 飞书项目 Meegle CLI Provider 设计

## 1. 背景

FlowRivet 已具备 Provider 中立的项目、工作项、缓存和看板基础。下一阶段接入飞书项目管理系统，让用户在 Codex 看板中读取当前飞书项目账号的个人待办；首版暂不处理 TAPD 兼容和切换。

飞书项目现已提供官方 Meegle CLI。CLI 使用用户 OAuth 身份、在系统钥匙串中管理凭据，并提供适合 Agent 消费的 JSON 输出。首版直接复用该 CLI，不实现飞书项目 OpenAPI 客户端，也不把飞书项目官方 MCP 加入 FlowRivet 运行链路。

官方资料：

- Meegle CLI：<https://github.com/larksuite/meegle-cli>
- 飞书项目 MCP 配置页：`https://project.feishu.cn/b/mcp`
- 默认服务域名：`project.feishu.cn`

## 2. 目标

- 新增 `feishu-project` Provider，通过官方 `meegle` CLI 读取当前用户的个人任务。
- 聚合本周待办、已逾期和最近 7 天完成项。
- 自动展示 CLI 返回的全部可访问项目，不要求用户先选择项目。
- 首版运行时只注册飞书项目；Provider 抽象保留以后接入其他项目管理系统的能力。
- 没有保存选择时默认使用飞书项目，不探测或迁移旧 TAPD 凭据。
- 从看板引导安装 CLI，并在已安装但未登录时发起用户 OAuth。
- 保持工作项、缓存、项目侧栏、刷新和 UI 合同 Provider 中立。
- Windows 完成真实只读 E2E；Linux 和 macOS 具备自动化命令与路径合同。

## 3. 非目标

- 在同一个看板中聚合多个项目管理系统的数据。
- 在 FlowRivet 内实现飞书项目 OpenAPI、远程 MCP Client 或 OAuth Token 管理。
- 自动安装全局软件，或静默修改用户的 npm 配置。
- 管理 Meegle CLI Profile；首版只使用 CLI 当前激活的 Profile。
- 选择、包含或排除飞书项目空间。
- 创建、修改、评论或流转飞书项目工作项。
- 后台常驻同步、Webhook、SSE 或服务端推送。
- 为 Meegle CLI 内部实现或未公开接口提供兼容层。

## 4. 用户决策

| 决策 | 结果 |
| --- | --- |
| 接入通道 | 只使用官方 Meegle CLI |
| 官方 MCP | 首版不注册、不依赖 |
| Provider 展示 | 首版只展示飞书项目，保留通用 Provider 合同 |
| 默认 Provider | 新用户默认 `feishu-project` |
| 既有用户迁移 | 首版不处理 TAPD 兼容迁移 |
| 安装体验 | 检测 CLI；缺失时展示官方安装命令 |
| 登录体验 | 从看板发起 OAuth，FlowRivet 不保存 Token |
| Profile | 只使用 Meegle CLI 当前 Profile |
| 项目范围 | 自动聚合全部返回项目，不要求选择 |
| 工作项范围 | 本周待办、已逾期、最近 7 天完成 |
| 写操作 | 只读 |

## 5. 架构

```text
Codex 看板 / MCP 工具
          |
          v
ProviderRegistry + ActiveProviderStore
          |
          |
          v
FeishuProjectProvider
          |
          v
  MeegleCliClient
          |
          v
官方 meegle CLI + 系统钥匙串
```

`ProviderRegistry` 负责按 ID 取得工作项、认证及可选的项目和详情能力。通用服务不得导入 Meegle 响应类型或执行 CLI。`FeishuProjectProvider` 只负责把飞书项目语义归一化；`MeegleCliClient` 只负责发现可执行文件、运行命令、限制资源、解析 JSON 和映射进程级错误。

首版不增加本地代理进程。每次读取启动一个短生命周期 CLI 子进程。同步单飞继续由现有 `WorkItemService` 管理，键中包含 Provider、Profile 和稳定账号身份，避免不同 Provider、Profile 或账号复用同一个 Promise。

现有 `WorkItemProvider` 是按项目查询的接口，而 `meegle mywork todo` 是账号级跨项目查询。核心层必须显式支持两种查询模式，不能让 Meegle Adapter 对每个项目重复执行同一条跨项目命令：

```ts
type WorkItemProvider = ProjectScopedWorkItemProvider | AccountScopedWorkItemProvider;

interface ProjectScopedWorkItemProvider {
  readonly queryMode: "project_scoped";
  readonly id: string;
  listProjectWorkItems(input: ProjectWorkItemQuery): Promise<WorkItemQueryResult>;
}

interface AccountScopedWorkItemProvider {
  readonly queryMode: "account_scoped";
  readonly id: string;
  listAccountWorkItems(input: AccountWorkItemQuery): Promise<AccountWorkItemQueryResult>;
}
```

`AccountWorkItemQueryResult` 返回带 `projectExternalId` 的 scopes 和从工作项聚合得到的项目。`WorkItemService` 只重构“如何取得 fresh scopes”这一段；后续缓存合并、最近完成过滤、排序、新鲜度、错误优先级和单飞保持共用。飞书项目使用 `account_scoped`；现有 TAPD Provider 只为保持代码库可编译做必要的接口适配，不进入首版运行时注册和验收范围。

`ProviderRegistry`、认证服务、活动授权进程和 `WorkItemSynchronizer` 都是 Companion 进程级实例，再注入每个请求级 MCP Server。否则当前每次 HTTP 请求创建 Server 的生命周期会导致设备码授权无法跨轮询请求保持或取消。

## 6. Provider 注册与默认选择

新增 `ProviderRegistry`，至少注册：

```ts
interface ProviderRegistration {
  id: "feishu-project" | string;
  displayName: string;
  auth: ProviderAuthService;
  projects?: ProjectManagementProvider;
  workItems: WorkItemProvider;
  details?: WorkItemDetailProvider;
}
```

项目发现是可选能力。飞书项目不注册该能力，项目侧栏由账号级工作项结果生成。项目目录工具遇到不支持该能力的 Provider 时返回 `provider_capability_unsupported`，看板打开流程不得把项目发现作为飞书项目同步的前置条件。

当前 Provider 保存到不含凭据的本地配置：

```json
{
  "version": 1,
  "activeProviderId": "feishu-project"
}
```

选择规则：

1. 配置不存在时写入并返回 `feishu-project`，不读取旧 TAPD 凭据。
2. 已保存且仍在注册表中的 Provider 保持不变。
3. 已保存 Provider 不再可用时回退 `feishu-project`，并返回非阻塞配置警告。
4. 用户切换成功后原子保存选择，为以后注册其他 Provider 预留能力。

项目目录、工作项缓存、最后同步时间和同步单飞继续按 `providerId` 隔离。切换后先读取目标 Provider 的可用缓存，再发起实时同步。全局自动刷新频率仍按现有规格跨 Provider 共用。

## 7. CLI 发现与执行边界

`MeegleCliClient` 不通过 Shell 拼接用户输入。它接收命令名和参数数组，并强制 JSON 输出。业务调用不允许覆盖可执行文件路径、服务域名、输出格式或认证头。

CLI 发现顺序：

1. 测试或高级配置显式注入的绝对路径；该配置不得来自 MCP 工具的任意用户输入。
2. 当前进程 `PATH` 中的平台可执行文件。
3. 找不到时返回 `provider_cli_missing`，不自动运行安装命令。

Windows 必须兼容原生可执行文件和 npm 生成的 `.cmd` shim。若需要通过 `cmd.exe` 启动 shim，只允许执行已解析的固定绝对路径和内部固定参数，并使用独立的 Windows 参数转义器；不得将项目、标题、URL 或其他业务数据拼进命令字符串。Linux 和 macOS 使用 `spawn` 参数数组直接执行。

资源限制：

- 普通状态命令超时 15 秒。
- 单页业务查询超时 30 秒。
- 登录命令最多等待 5 分钟。
- 单进程标准输出和错误输出各限制 10 MiB。
- 超时或超过输出限制时终止完整子进程树。
- 仅接受退出码 0 且通过 Schema 校验的 JSON；无效输出不得覆盖缓存。

实现前通过只读探针记录：CLI 版本、`auth status`、`user me`、`mywork todo` 的公开参数和脱敏响应结构。首版最低兼容版本固定为已验证的 `1.0.19`；版本过低返回 `provider_cli_unsupported` 并展示升级命令。不得依赖 CLI 的 Go 内部包或缓存文件格式。`config profile current` 在该版本即使指定 JSON 格式仍返回单行文本，Profile 读取必须使用独立的受限文本合同。

## 8. 安装与认证状态机

FlowRivet 不读取、保存、传输或记录 Meegle Token。凭据生命周期完全归官方 CLI 和系统钥匙串管理。账号连接状态与一次授权会话是两个独立合同：前者只回答“当前账号能否使用”，后者只回答“本次授权进行到哪里”。

账号连接状态：

```text
checking
  -> cli_missing
  -> disconnected
  -> connected
  -> expired
  -> unavailable
```

`ProviderConnection` 不再包含 `authorizing`。行为：

- `cli_missing`：展示 `npx -y @lark-project/meegle@latest install`，提供复制按钮和“重新检测”。页面不自动执行全局安装。
- `disconnected`：提供“连接飞书项目”，发起独立的 `ProviderLoginSession`。
- `connected`：先读取当前 Profile，再调用 `meegle user me --profile <captured-profile> --format json` 取得稳定账号标识和显示名，只把非敏感身份元数据交给通用合同。
- `expired`：保留缓存并引导重新授权。
- `unavailable`：网络或服务端异常，保留凭据与缓存，不错误地要求重新登录。

授权会话状态：

```text
starting -> waiting -> verifying -> succeeded
    |          |           |
    +----------+-----------+-> failed | expired | cancelled
```

新增进程级 `ProviderLoginCoordinator`，按 Provider 管理会话；Provider 只提供认证 Driver，Meegle Driver 负责官方设备码两阶段协议。当前 UI 只操作 Meegle CLI 的当前 Profile，因此每个 Provider 同时最多一个活动会话；会话启动时捕获 Profile，init、poll、状态与身份命令都显式使用该 Profile。重复开始幂等复用；活动期间检测到当前 Profile 改变时，会话进入 `failed`，不得把凭据或身份归到新 Profile。授权会话安全快照包含：

```text
sessionId, providerId, state,
startedAt, updatedAt, expiresAt,
browserLaunch: opened | manual_required,
error?: { code, retryable, recoveryAction, requestId },
manualFallback?: { verificationUri, userCode }
```

`manualFallback` 只在系统浏览器启动失败且会话仍有效时返回；此时 `provider_browser_launch_failed` 是可恢复告警，会话保持 `waiting`，不是授权终态。正常流程不在看板显示验证码。完整授权 URL 已包含用户码，用户只需在飞书页面点击一次授权。开始新会话时替换同一 Provider 已保留的旧终态快照。

非 TTY Companion 使用已验证的官方两阶段 JSON 合同：`phase init` 返回完整授权 URL、用户码、设备码和轮询间隔，`phase poll --once` 返回等待、成功或过期状态。Coordinator 调用注入的 `SystemBrowserLauncher` 打开系统默认浏览器，并由 Meegle Driver 按服务端间隔轮询。浏览器启动器不接受 MCP 调用方传入 URL，只能打开 Driver 内部生成、通过域名允许列表校验的 HTTPS 地址。Windows、macOS 和 Linux 各自使用固定可执行文件与参数数组，不拼接 shell 命令。

页面每 1.5 秒读取授权会话安全快照。等待超过 15 秒只更新提示，不提前终止事务，也不显示“检查授权结果”按钮。用户刷新看板、关闭面板或重新打开时，通过 `get_provider_login` 按当前 Provider 接回 Companion 内存中的唯一活动或最近终态会话；关闭面板不取消授权。Companion 重启后不恢复临时会话，而是先重新检查 CLI：若凭据已落地则直接进入 `connected`，否则开始新会话。

设备码轮询成功后进入 `verifying`，必须再执行 `auth status` 和 `user me` 才能进入 `succeeded` 与 `connected`。身份验证阶段允许有限重试；网络或服务端异常保留 CLI 凭据，并引导“重新检查连接”，不得要求重新授权。授权成功与首次任务同步分离：同步失败时仍显示已连接，并在看板内提供缓存或重试。

活动会话最多保留 5 分钟。成功、失败、取消或过期后立即终止相关 CLI 子进程并清除授权 URL、用户码、设备码和 client ID；不含敏感信息的终态快照保留 10 分钟用于页面恢复，随后自动删除。授权进程退出、取消或超时不删除 CLI 已有凭据。

“断开飞书项目”调用官方 `meegle auth logout`，会改变当前 CLI Profile，必须经过用户确认。断开后只清除 `feishu-project` 活跃缓存和非敏感目录，不影响 TAPD。

同步开始时捕获当前 Profile，并为本次同步的每条业务命令显式传入该 Profile，避免用户在终端切换默认 Profile 后续页落到另一账号。同步结束前再次读取该 Profile 的 `user me`；稳定账号或租户标识发生变化时丢弃本次结果并返回 `provider_unauthorized`，不得写入缓存。

## 9. 个人任务同步

一次同步读取三种 action，并完整分页：

```text
mywork todo --action this_week --page-num N --format json
mywork todo --action overdue   --page-num N --format json
mywork todo --action done      --page-num N --format json
```

`1.0.19` 已验证每页 50 条，响应为 `{ list, total }`，没有游标或 `has_more`；空页和超出尾页时 `list` 为 `null`。Provider 从第 1 页开始，遇到 `list == null` 或不足 50 条时终止，并用 `total` 交叉校验累计数量；不能固定只取第一页。每个 action 设置 50,000 条或 1,000 页的安全上限，任一上限触发时返回 `provider_output_limit_exceeded`，不得把截断结果标为成功或覆盖缓存。

`1.0.19` 的 `done` 没有完成时间过滤参数。真实样本虽按可信完成时间倒序，但单账号样本不足以形成服务端排序保证；首版必须在安全上限内完整分页，再在本地过滤最近 7 天，不按时间提前停止。

同步流程：

1. 先验证 `auth status` 和当前用户身份。
2. 顺序或有限并发读取三个 action 的全部页；首版并发上限为 2。
3. 按稳定键去重：`feishu-project + project_key + work_item_type + work_item_id`。
4. `this_week` 与 `overdue` 重复时合并，保留更完整字段并标记逾期。
5. `done` 只保留可信完成时间不早于当前时间减 7 天的记录。
6. 完成时间缺失时使用官方明确标记的状态完成时间；仍缺失则不进入已完成列。
7. 项目侧栏从归一化工作项的项目信息聚合，不要求项目发现或选择。

已验证 `mywork todo` 提供标题、项目、类型、状态/节点和完成时间，但不提供工作项 URL；默认 `workitem get` 也不提供 URL。首版不猜测 URL 路径，也不为此发起详情补齐。若后续看板字段确需补齐，Provider 才可按项目分组调用官方 `workitem batch-get`，单批不超过 CLI 公布的限制。

任一 action 的任一分页失败时，该 action 视为失败；不得用已取得的部分页面覆盖该 scope 的最近成功缓存。其他 action 可以继续并形成现有的 mixed/offline 快照。

## 10. 工作项归一化

公开 `WorkItem` 合同保持不变：

```ts
interface WorkItem {
  key: string;
  providerId: string;
  externalId: string;
  projectExternalId: string;
  projectName: string;
  kind: "requirement" | "task" | "defect" | "other";
  providerItemType: string;
  title: string;
  stage: "todo" | "in_progress" | "in_review" | "done";
  providerStatus: string;
  priority?: string;
  dueAt?: string;
  completedAt?: string;
  updatedAt?: string;
  externalUrl?: string;
}
```

映射规则：

- `providerId` 固定为 `feishu-project`。
- `done` action 的可信记录固定映射为 `done`。
- 活跃记录优先使用返回的流程状态 ID、状态类别或节点元数据映射 `todo`、`in_progress`、`in_review`。
- 未识别活跃状态保守映射为 `todo`，保留 `providerStatus`，不得丢弃工作项。
- 飞书项目类型映射基于稳定类型 key，不基于可编辑显示名；未知类型进入 `other`。
- `externalUrl` 可缺失；存在时只接受飞书项目 HTTPS 域名或 CLI 返回并通过允许列表校验的租户域名。缺失时界面不得猜测路径或提供外链操作。
- 所有日期先验证为有效时间，再转换 ISO 8601；无效可选日期忽略，稳定键字段无效则拒绝该记录并把 scope 标记为合同错误。

第一轮真实探针必须产出脱敏 Fixture：删除用户、项目、标题、ID、URL、正文和 Token，仅保留字段名、类型、枚举形状及合成值。状态和类型映射测试只依赖该 Fixture 与公开元数据，不依赖中文显示名猜测。

## 11. UI 与工具行为

连接菜单首版只展示飞书项目。Provider 列表和活动选择合同继续保留，以便以后新增其他项目管理系统时无需修改看板合同。

切换时页面展示目标 Provider 的连接状态；未连接时不显示误导性空看板。飞书项目连接面板包含 CLI 状态、当前 Profile、账号显示名、安装/升级指引、连接、重新检测和断开操作。React 只持有授权会话安全快照；访问 Token、设备码、client ID、CLI 原始输出和钥匙串位置不得进入 React 状态或浏览器持久化。

未连接时主操作只有“连接飞书项目”。点击后依次展示“正在准备安全授权会话”“请在浏览器中完成飞书授权”“正在确认账号”；系统浏览器自动打开。等待超过 15 秒显示“仍在等待飞书确认”，保留“重新打开授权页”和“取消”，但不要求用户手动检查。成功后自动关闭授权面板并加载看板；首次同步失败独立展示，不回退登录状态。

失败或过期必须退出活动等待态、清除旧授权数据、显示稳定错误原因和唯一恢复动作。浏览器启动失败时会话继续等待，并显示临时手动链接和备用验证码；CLI 能提供结构化拒绝状态时显示“用户拒绝”，否则未知终态归为一般授权失败；拒绝、一般失败或过期均显示“重新授权”。网络或身份验证异常显示“重新检查连接”；CLI 缺失或版本过低显示安装或升级指引。有缓存看板的重新授权对话框允许关闭，页头继续显示“飞书授权中”；首次连接的全页空状态没有可关闭面板。重新打开可接回进度。

Provider 选择、复制安装命令、连接、取消、重新打开授权页和重新检测必须支持键盘操作并具有可读名称。连接及授权会话状态变化使用非打断式 live region；临时手动链接和备用验证码必须可复制并可被辅助技术读取。切换 Provider 后焦点进入目标 Provider 的状态标题；错误提示不得只依赖颜色区分。

现有 Provider 中立工具继续使用：

- `open_my_taskboard`
- `list_my_work_items`
- `refresh_my_work_items`
- 项目和偏好读取工具

新增或重构：

- `list_providers`：返回可用 Provider 及非敏感连接状态。
- `get_active_provider`：读取当前 Provider。
- `set_active_provider`：校验并保存选择，不隐式断开旧 Provider。
- `get_provider_connection`：读取指定 Provider 的账号连接状态和非敏感身份，不承载授权进行态。
- `start_provider_login`：开始或复用授权会话，并尝试打开系统默认浏览器；返回会话安全快照。
- `get_provider_login`：读取当前 Provider 的唯一活动或最近终态会话；不存在时返回空结果。
- `reopen_provider_login`：重新打开活动会话的授权页；只接受会话 ID，不接受 URL。
- `cancel_provider_login`：取消匹配的活动会话，不删除既有凭据。
- `disconnect_provider`：确认后调用 Provider 断开能力并清除该 Provider 活跃缓存。

不新增 TAPD 兼容或迁移工具。通用认证工具只接受已注册的 `providerId`，不得接受任意命令、可执行文件、Profile、host 或 CLI 参数。

只读阶段不注册移动、更新、评论或流程流转工具。卡片不可拖动。整张卡片的非操作区具有按钮语义，鼠标点击、`Enter` 或 `Space` 均打开详情抽屉；原系统链接只存在于详情操作区，不再替代详情交互。

### 11.1 飞书项目详情

`FeishuProjectWorkItemDetailProvider` 通过官方 Meegle CLI `workitem get` 读取当前卡片对应工作项，并复用现有 `WorkItemDetail` 通用合同。至少映射标题、类型、状态、优先级、负责人、创建人、创建/更新/开始/截止时间、安全清洗后的描述和允许列表内的原始链接。字段和角色模型以真实脱敏探针为准；缺失的可选字段省略，不得伪造。

详情实时按需读取且不写入 SQLite。打开抽屉先展示卡片基础信息与加载状态；失败时保留基础信息、原始链接和重新加载操作。旧请求不得覆盖后打开的卡片。正文按不可信外部内容处理，服务端执行允许列表清洗与 256 KiB 上限。

### 11.2 直接交给 Codex

详情抽屉提供单一主操作“交给 Codex 处理”。UI 先调用 `prepare_work_item_execution` 幂等创建或恢复执行，但不立即发送 handoff；页面先让用户选择本次“仅处理当前事项”或“需要修改代码”。选择仅对当前执行轮次有效，不永久写回飞书工作项或记为默认值。

UI 通过 `set_work_item_execution_mode` 写入 `non_code | code`。`non_code` 直接通过 MCP Apps `App.sendMessage()` 发送 `role: "user"` 的最小结构化 handoff；`code` 在没有仓库绑定时返回 `repository_required`，关联仓库后再发送。Codex 不再根据标题强制猜测分析、拆解或研发分类。正常流程不显示复制按钮；宿主不支持或拒绝 `ui/message` 时保留执行记录并提供重试，仅在错误详情兼容区提供复制降级。

在 `prepared`、`awaiting_repository` 和 handoff 尚未成功送达的 `ready` 状态，用户可修改执行模式；切换为 `non_code` 时关闭仓库弹窗并继续同一执行。handoff 成功送达、创建 Git 分支、产生 MR 或执行产物，或进入运行及后续状态后，模式锁定并返回 `execution_mode_locked`。

bridge 必须独立暴露 `sendMessage` 与 `callTool`，并在发送前检查宿主 `message` capability。UI 使用明确的 `handoff_sending`、`processing`、`repository_required`、`failed` 和 `completed` 状态。刷新或重新打开看板后通过 `get_work_item_execution` 恢复未终止执行。

### 11.3 按需选择 GitLab 仓库

仓库选择使用居中的独立模态框，不嵌套在详情抽屉中。模态框提供项目搜索与分页、已有仓库/克隆仓库模式、明确选中态和路径就地校验；关闭后恢复触发点焦点并保留详情。宿主支持目录选择时使用系统目录选择器，否则回退为绝对路径输入。只复核最近使用过的精确路径，不扫描磁盘。

用户确认后调用 `bind_execution_repository`。绑定成功后 UI 通过 `sendMessage` 通知当前对话继续同一 `executionId`，无需复制或重新组织提示词。GitLab 继续只使用用户身份的 `git + glab`，不降级为自建 API Client，也不绕过受保护分支、审批和合并规则。

## 12. 错误与日志

新增稳定错误码：

| 错误码 | 含义 |
| --- | --- |
| `provider_cli_missing` | 未找到 `meegle` |
| `provider_cli_unsupported` | CLI 版本不兼容 |
| `provider_capability_unsupported` | 当前 Provider 不支持所请求能力 |
| `provider_browser_launch_failed` | 系统浏览器无法打开，需使用临时手动入口 |
| `provider_login_denied` | CLI 提供结构化拒绝状态时，用户拒绝本次授权 |
| `provider_login_failed` | 无法进一步分类的一般授权失败 |
| `provider_login_expired` | 设备授权会话已过期 |
| `provider_login_cancelled` | 用户取消本次授权 |
| `provider_identity_validation_failed` | 授权后无法确认稳定账号身份 |
| `provider_not_connected` | 当前 Profile 未登录 |
| `provider_unauthorized` | Token 失效或服务端拒绝 |
| `provider_unavailable` | 网络或飞书项目服务不可用 |
| `provider_timeout` | CLI 命令超时 |
| `provider_output_limit_exceeded` | 输出超过限制 |
| `provider_contract_invalid` | JSON 或字段结构不符合合同 |
| `work_item_sync_failed` | 无可用实时或缓存 scope |
| `work_item_detail_forbidden` | 当前用户不能读取该详情 |
| `work_item_detail_invalid_response` | 详情结构不符合统一合同 |
| `codex_handoff_unsupported` | 当前宿主不支持 `ui/message` |
| `codex_handoff_failed` | 消息未送达当前 Codex 对话 |
| `execution_state_conflict` | 执行状态版本已变化或请求重复冲突 |
| `execution_mode_locked` | handoff 已送达或执行已开始，不能修改是否需要代码 |
| `execution_handoff_conflict` | handoff 确认 ID 与当前执行不一致 |
| `repository_required` | 用户选择修改代码，但执行尚未绑定代码仓库 |
| `repository_path_invalid` | 本地仓库路径无效或远程不匹配 |

每个授权 MCP 工具调用生成 `requestId`，授权工具结果合同显式返回该字段；不为本次改造无关的工具批量改变响应 Schema。每个授权会话生成非敏感 `correlationId`，用于串联状态迁移日志。错误快照包含稳定错误码、是否可重试、唯一恢复动作和最近一次 `requestId`。CLI 的非零退出码必须结合结构化错误、退出码和 `auth status` 分类，禁止依赖本地化 stderr 的模糊字符串匹配。只有经过探针验证的结构化状态可以映射 `provider_login_denied`；未知授权终态映射 `provider_login_failed`，其他未知失败统一降级为 `provider_unavailable` 或 `work_item_sync_failed`，不得误报未登录。

日志只允许：`requestId`、会话 `correlationId`、工具名、Provider ID、CLI 版本、命令类别、状态迁移、结果、稳定错误码、重试次数、耗时、页数、工作项数量和缓存新鲜度。禁止记录命令完整参数、环境变量、PATH、Token、client ID、设备码、授权地址、验证码、Profile 内容、用户、项目、工作项、标题、URL、stdout 或 stderr 原文。

### 12.1 主要威胁与约束

1. PATH 劫持或恶意可执行文件冒充 `meegle`：执行前解析固定绝对路径、验证版本合同，运行期间不重新按 PATH 查找；MCP 输入不得覆盖路径。
2. CLI 输出携带恶意或超大内容：限制 stdout/stderr，使用 Schema 和字段长度校验，标题只作为 React 文本渲染，外链执行域名允许列表。
3. Profile 或账号在同步中切换导致跨账号缓存污染：捕获并显式传入 Profile，使用稳定账号/租户键隔离缓存，同步前后复核身份，变化时丢弃结果。
4. 外部浏览器启动被滥用：启动器不暴露任意 URL 参数，只接受认证 Driver 产生且通过 Provider 域名允许列表校验的 HTTPS 地址；平台命令使用固定可执行文件和参数数组。
5. 临时授权数据残留：仅活动会话在内存持有完整授权 URL、用户码、设备码和 client ID；进入任一终态立即清除，禁止写入磁盘、日志、分析事件或错误对象。
6. 本地 MCP 被远程调用后触发浏览器或授权副作用：含授权副作用的 Companion 只允许绑定回环地址；若配置为非回环地址则启动失败，直到未来实现独立的客户端认证与授权机制。HTTP 层继续拒绝非回环 Origin，授权工具不得放宽该限制。
7. 工作项正文对 Codex 进行提示注入：handoff 明确将详情标记为不可信业务数据；正文不能改变工具权限、仓库边界、系统指令或确认策略。
8. 仓库路径或项目名称注入命令：所有 Git、`glab` 和 Meegle 调用使用类型化参数数组，不把用户输入拼接到 Shell 字符串。
9. 重复消息产生重复执行：prepare、执行模式选择、仓库绑定和恢复均使用 `executionId`、幂等键和状态版本校验。

## 13. 测试策略

### 13.1 单元与合同测试

- 可执行文件缺失、版本过低、超时、取消、非零退出和输出上限。
- Windows 可执行文件/`.cmd`、Linux/macOS 路径与参数数组合同。
- JSON Schema 成功、未知字段、缺字段、无效 JSON 和超大响应。
- `auth status` 的已连接、未登录、失效和服务不可用分类。
- 授权会话全部合法状态迁移、非法迁移拒绝、重复开始幂等、5 分钟超时和 10 分钟终态清理。
- 设备授权成功、拒绝、过期、取消、浏览器启动失败、身份验证失败和网络异常分类及唯一恢复动作。
- Windows、macOS、Linux 系统浏览器启动器的固定命令、参数数组、HTTPS 与域名允许列表合同。
- 三种 action 的完整分页、空页、重复页、部分失败和去重。
- 完成项 7 天边界、缺少可信完成时间和无效日期。
- 类型、状态、项目、URL 和稳定键归一化。
- Provider Registry 默认值、无效选择回退和原子保存失败。
- 不同 Provider 的缓存、账号身份和同步单飞隔离合同。
- 日志和 MCP 结果不包含凭据或业务内容。

测试使用假 CLI Runner 和脱敏合成 Fixture，不调用真实账号。

### 13.2 组件与浏览器测试

- 新用户默认展示飞书项目连接面板。
- 未安装展示安装命令；重新检测可恢复。
- 未登录、授权会话各阶段、已连接、失效和离线状态可区分。
- 一键授权不显示“检查授权结果”；15 秒后只更新等待提示，授权成功后自动进入看板。
- 刷新、关闭和重新打开页面可接回当前会话；终态清除旧验证码并展示唯一恢复动作。
- 系统浏览器启动失败时显示临时手动入口；正常流程不显示验证码。
- 授权成功但首次任务同步失败时仍显示 `connected`，并提供同步重试或缓存数据。
- Provider 切换保留各自缓存和连接状态。
- 全部项目自动出现在侧栏，侧栏只筛选、不控制同步。
- 只读卡片不可拖动，详情链接通过允许列表校验。
- Provider 选择和认证流程具备键盘、焦点、live region 与非颜色错误提示测试。
- 点击卡片始终打开详情；加载、成功、失败、重试和切换卡片竞态正确。
- 飞书详情的描述、人员、时间和原始链接按统一合同显示，缺失可选字段不伪造。
- “交给 Codex 处理”成功调用 `ui/message`，正常流程不出现复制按钮。
- 分析与拆解任务不打开仓库模态框；研发任务缺少绑定时自动打开。
- 仓库模态框支持搜索、已有/克隆模式、路径校验、错误保留和焦点恢复。
- 仓库确认后自动发送恢复消息；刷新页面可以恢复未结束执行。
- 桌面和窄窗口无文字溢出或控件重叠。

### 13.3 真实 E2E

1. 在 Windows 安装官方 CLI，并设置 `project.feishu.cn`。
2. 确认 CLI 未登录，从 FlowRivet 点击一次“连接飞书项目”，验证系统默认浏览器自动打开。
3. 授权等待期间刷新看板，验证接回同一会话且不出现手动检查按钮。
4. 在飞书页面点击一次授权；页面显示成功后验证 `auth status` 和 `user me` 成功。
5. 不执行任何手动检查，验证 FlowRivet 在 CLI 返回成功后 2 秒内进入 `connected` 并自动加载看板；从飞书页面成功到 CLI 检测成功的允许时间为服务端轮询间隔加单次命令耗时。
6. 同步 `this_week`、`overdue`、`done` 全部页面，将归一化任务 ID 数量与三条 CLI 原始命令脱敏核对。
7. 验证跨项目侧栏、重复项合并和最近 7 天完成过滤。
8. 模拟首次任务同步失败，验证仍保持 `connected`；模拟断网、Token 失效和 CLI 升级不兼容，验证缓存与错误状态。
9. 点击真实飞书工作项，核对详情中的状态、人员、时间、描述和原始链接。
10. 对流程、分析或拆解事项选择“仅处理当前事项”，确认当前 Codex 对话直接收到并开始处理，且不要求仓库。
11. 对需要修改代码的事项选择“需要修改代码”，确认仓库模态框出现；绑定内网 GitLab 仓库后，Codex 自动继续同一执行。
12. 刷新并重新打开插件，确认未结束执行状态可恢复且未重复创建执行。

真实验收记录不得保存 stdout、用户、项目、工作项或授权信息。

## 14. 准入与准出标准

### 14.1 准入

- 现有 Provider 中立项目、工作项、缓存和自动刷新测试通过。
- Node.js 满足官方 Meegle CLI 要求。
- 测试用户能访问至少一个飞书项目空间和个人工作视图。
- 飞书项目 MCP Server 可以保持关闭，验证流程不依赖远程 MCP。
- 没有真实账号时只完成自动化合同，不宣称真实 E2E 通过。

### 14.2 准出

- 新用户默认飞书项目，不读取或迁移旧 TAPD 凭据。
- CLI 未安装、未登录、已连接、失效和离线状态正确区分。
- 用户只需点击一次连接和一次飞书授权即可进入看板；无需输入验证码或点击“检查授权结果”。
- 页面刷新、关闭和重新打开不会丢失 Companion 运行期间的授权状态；Companion 重启后按 CLI 实际登录状态恢复。
- Coordinator 记录授权终态后 2 秒内反映到 UI，并提供准确且唯一的恢复动作；外部授权成功的检测时间不短于 CLI 服务端轮询间隔。
- FlowRivet 不持久化或记录 Token、client ID、设备码、授权地址或验证码；仅系统浏览器启动失败时向当前临时 UI 返回授权地址与备用验证码，进入终态后立即清除。
- 三种 action 完整分页、稳定去重，并严格保留最近 7 天完成项。
- 看板结果与官方 CLI 在脱敏任务 ID 数量上核对一致。
- 点击飞书卡片可读取完整详情，时间、描述、处理人和原始链接与真实记录一致。
- 点击“交给 Codex 处理”后当前对话直接收到任务，无需复制提示词。
- 分析和拆解不要求仓库；研发任务只在需要时打开独立仓库模态框。
- 仓库确认后 Codex 自动恢复同一执行，刷新后执行状态仍可恢复。
- 自动聚合全部项目，不要求选择；项目侧栏筛选正确。
- Provider 隔离合同通过，首版运行时只注册飞书项目。
- 无效或截断 CLI 输出不会覆盖最近成功缓存。
- 单元、合同、类型检查、生产构建和浏览器 E2E 通过。
- Windows 真实只读 E2E 通过；Linux/macOS 跨平台合同通过。

## 15. 实现前必须完成的探针

以下验证是实施计划的第一批任务，不得用推测代替：

1. `meegle --version` 的输出和最低兼容版本策略。
2. Windows 安装结果是原生可执行文件还是 npm `.cmd` shim。
3. `auth login --device-code` 是否提供稳定结构化授权事件。
4. `auth status --format json` 和 `user me --format json` 的 Schema 与稳定身份字段。
5. `mywork todo` 的页大小参数、分页元数据、空页语义和最大页数。
6. 三种 action 的真实脱敏响应字段、重复关系和完成时间来源。
7. 活跃工作项是否含足够的项目、类型、状态、标题和 URL；是否需要 `+batch-get` 补齐。
8. CLI 401、403、429、5xx、网络失败和超时是否有稳定结构化错误。
9. `workitem get`、`workitem meta-fields` 的详情、角色、正文和时间字段，以及不同工作项类型的缺失字段行为。
10. 当前 Codex 桌面宿主是否接收 MCP Apps `ui/message`、是否把消息送入当前对话，以及工具结果通知能否驱动已打开 App 恢复执行状态。
11. 当前 Codex 宿主的目录选择能力；不支持时验证绝对路径输入降级方案。

探针若推翻认证、分页、必要字段、`ui/message`、工具结果通知或目录选择假设，必须先更新本规格并重新审核，再继续实现。若当前 Codex 宿主不支持 `ui/message`，直接接管不得以模拟消息或自动复制冒充通过，只能进入明确的兼容降级状态。
