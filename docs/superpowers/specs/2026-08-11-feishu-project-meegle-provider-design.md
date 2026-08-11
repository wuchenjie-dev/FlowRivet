# FlowRivet 飞书项目 Meegle CLI Provider 设计

## 1. 背景

FlowRivet 已通过 Provider 中立的项目、工作项、缓存和看板合同接入 TAPD。下一阶段接入飞书项目管理系统，让用户在 Codex 看板中读取当前飞书项目账号的个人待办，并在 TAPD 与飞书项目之间切换。

飞书项目现已提供官方 Meegle CLI。CLI 使用用户 OAuth 身份、在系统钥匙串中管理凭据，并提供适合 Agent 消费的 JSON 输出。首版直接复用该 CLI，不实现飞书项目 OpenAPI 客户端，也不把飞书项目官方 MCP 加入 FlowRivet 运行链路。

官方资料：

- Meegle CLI：<https://github.com/larksuite/meegle-cli>
- 飞书项目 MCP 配置页：`https://project.feishu.cn/b/mcp`
- 默认服务域名：`project.feishu.cn`

## 2. 目标

- 新增 `feishu-project` Provider，通过官方 `meegle` CLI 读取当前用户的个人任务。
- 聚合本周待办、已逾期和最近 7 天完成项。
- 自动展示 CLI 返回的全部可访问项目，不要求用户先选择项目。
- 在连接菜单中切换 TAPD 与飞书项目；同一时刻看板只展示当前 Provider。
- 新安装或没有保存选择时默认使用飞书项目，保留已有用户明确选择的 TAPD。
- 从看板引导安装 CLI，并在已安装但未登录时发起用户 OAuth。
- 保持工作项、缓存、项目侧栏、刷新和 UI 合同 Provider 中立。
- Windows 完成真实只读 E2E；Linux 和 macOS 具备自动化命令与路径合同。

## 3. 非目标

- 在同一个看板中聚合 TAPD 与飞书项目数据。
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
| Provider 展示 | TAPD 与飞书项目单选切换 |
| 默认 Provider | 新用户默认 `feishu-project` |
| 既有用户迁移 | 保留已明确保存的 Provider 选择 |
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
          +-------------------+
          |                   |
          v                   v
 TapdProvider        FeishuProjectProvider
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

`AccountWorkItemQueryResult` 返回带 `projectExternalId` 的 scopes 和从工作项聚合得到的项目。`WorkItemService` 只重构“如何取得 fresh scopes”这一段；后续缓存合并、最近完成过滤、排序、新鲜度、错误优先级和单飞保持共用。TAPD 继续使用 `project_scoped`，飞书项目使用 `account_scoped`。

`ProviderRegistry`、认证服务、活动授权进程和 `WorkItemSynchronizer` 都是 Companion 进程级实例，再注入每个请求级 MCP Server。否则当前每次 HTTP 请求创建 Server 的生命周期会导致设备码授权无法跨轮询请求保持或取消。

## 6. Provider 注册与默认选择

新增 `ProviderRegistry`，至少注册：

```ts
interface ProviderRegistration {
  id: "tapd" | "feishu-project" | string;
  displayName: string;
  auth: ProviderAuthService;
  projects?: ProjectManagementProvider;
  workItems: WorkItemProvider;
  details?: WorkItemDetailProvider;
}
```

项目发现是可选能力。TAPD 继续通过 `ProjectManagementProvider` 发现项目；飞书项目不注册该能力，项目侧栏由账号级工作项结果生成。项目目录工具遇到不支持该能力的 Provider 时返回 `provider_capability_unsupported`，看板打开流程不得把项目发现作为飞书项目同步的前置条件。

当前 Provider 保存到不含凭据的本地配置：

```json
{
  "version": 1,
  "activeProviderId": "feishu-project"
}
```

迁移规则：

1. 配置不存在且本机没有旧版 TAPD 凭据时返回 `feishu-project`。
2. 配置不存在但本机存在旧版 TAPD 凭据时，一次性迁移为 `tapd` 并原子写入选择；凭据即使已过期也表示该用户此前明确使用 TAPD，连接状态由 TAPD Adapter 另行判断。
3. 已保存且仍在注册表中的 Provider 保持不变。
4. 已保存 Provider 不再可用时回退 `feishu-project`，并返回非阻塞配置警告。
5. 用户切换成功后原子保存选择。
6. 切换不退出另一 Provider，也不删除其凭据、缓存或项目目录。

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

FlowRivet 不读取、保存、传输或记录 Meegle Token。凭据生命周期完全归官方 CLI 和系统钥匙串管理。

状态机：

```text
checking
  -> cli_missing
  -> disconnected
  -> authorizing
  -> connected
  -> expired
  -> unavailable
```

行为：

- `cli_missing`：展示 `npx -y @lark-project/meegle@latest install`，提供复制按钮和“重新检测”。页面不自动执行全局安装。
- `disconnected`：提供“连接飞书项目”，后台发起官方用户授权流程。
- `authorizing`：展示官方授权地址和验证码，允许取消；不得显示或记录访问 Token。
- `connected`：先读取当前 Profile，再调用 `meegle user me --profile <captured-profile> --format json` 取得稳定账号标识和显示名，只把非敏感身份元数据交给通用合同。
- `expired`：保留缓存并引导重新授权。
- `unavailable`：网络或服务端异常，保留凭据与缓存，不错误地要求重新登录。

非 TTY Companion 优先使用官方设备码流程：

```text
meegle auth login --device-code --host project.feishu.cn
```

已验证 `1.0.19` 的设备码授权提供稳定两阶段 JSON 合同：`phase init` 返回授权 URL、用户码、设备码和轮询间隔，`phase poll --once` 返回等待、成功或过期状态。页面直接渲染授权 URL 与用户码，并按服务端间隔轮询；若未来版本不再满足 Schema，FlowRivet 不解析自由文本，而是降级为展示可复制命令，并周期性执行：

```text
meegle auth status --format json
```

一旦状态成功即进入 `connected`。授权进程退出、取消或超时不删除 CLI 已有凭据。

授权地址和验证码只允许存在于当前授权事务的内存和临时 UI 状态中，不写入本地配置、缓存、日志或分析事件。每个 Provider/Profile 同时最多一个授权事务；重复开始返回同一事务状态。切换看板 Provider 不自动取消授权，用户可以返回飞书项目连接面板查看状态或显式取消；授权进行中不得执行断开。

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

连接菜单增加 Provider 选择项：

- 飞书项目，默认。
- TAPD。

切换时页面展示目标 Provider 的连接状态；未连接时不显示误导性空看板。飞书项目连接面板包含 CLI 状态、当前 Profile、账号显示名、安装/升级指引、连接、重新检测和断开操作。只有当前事务的授权地址、验证码和过期时间可以进入临时 React 状态；访问 Token、CLI 原始输出和钥匙串位置不得进入 React 状态或浏览器持久化。

Provider 选择、复制安装命令、连接、取消和重新检测必须支持键盘操作并具有可读名称。连接状态变化使用非打断式 live region；授权地址与验证码既可复制也可被辅助技术读取。切换 Provider 后焦点进入目标 Provider 的状态标题；错误提示不得只依赖颜色区分。

现有 Provider 中立工具继续使用：

- `open_my_taskboard`
- `list_my_work_items`
- `refresh_my_work_items`
- 项目和偏好读取工具

新增或重构：

- `list_providers`：返回可用 Provider 及非敏感连接状态。
- `get_active_provider`：读取当前 Provider。
- `set_active_provider`：校验并保存选择，不隐式断开旧 Provider。
- `get_provider_connection`：读取指定 Provider 的连接状态和非敏感身份。
- `start_provider_login`：开始或复用授权事务，返回临时授权指引。
- `cancel_provider_login`：取消当前授权事务，不删除既有凭据。
- `disconnect_provider`：确认后调用 Provider 断开能力并清除该 Provider 活跃缓存。

TAPD 专属兼容工具暂时保留，但 UI 不再直接依赖其命名。通用认证工具只接受已注册的 `providerId`，不得接受任意命令、可执行文件、Profile、host 或 CLI 参数。

只读阶段不注册移动、更新、评论或流程流转工具。卡片不可拖动。飞书项目未提供详情 Adapter 时，仅在工作项含通过允许列表校验的原链接时允许打开；没有链接时保持卡片只读，不得猜测 URL、调用 TAPD 详情服务或显示错误抽屉。

## 12. 错误与日志

新增稳定错误码：

| 错误码 | 含义 |
| --- | --- |
| `provider_cli_missing` | 未找到 `meegle` |
| `provider_cli_unsupported` | CLI 版本不兼容 |
| `provider_capability_unsupported` | 当前 Provider 不支持所请求能力 |
| `provider_not_connected` | 当前 Profile 未登录 |
| `provider_unauthorized` | Token 失效或服务端拒绝 |
| `provider_unavailable` | 网络或飞书项目服务不可用 |
| `provider_timeout` | CLI 命令超时 |
| `provider_output_limit_exceeded` | 输出超过限制 |
| `provider_contract_invalid` | JSON 或字段结构不符合合同 |
| `work_item_sync_failed` | 无可用实时或缓存 scope |

CLI 的非零退出码必须结合结构化错误、退出码和 `auth status` 分类，禁止依赖本地化 stderr 的模糊字符串匹配。若官方 CLI 没有结构化错误，未知失败统一降级为 `provider_unavailable` 或 `work_item_sync_failed`，不得误报未登录。

日志只允许：`requestId`、工具名、Provider ID、CLI 版本、命令类别、结果、稳定错误码、耗时、页数、工作项数量和缓存新鲜度。禁止记录命令完整参数、环境变量、PATH、Token、授权地址、验证码、Profile 内容、用户、项目、工作项、标题、URL、stdout 或 stderr 原文。

### 12.1 主要威胁与约束

1. PATH 劫持或恶意可执行文件冒充 `meegle`：执行前解析固定绝对路径、验证版本合同，运行期间不重新按 PATH 查找；MCP 输入不得覆盖路径。
2. CLI 输出携带恶意或超大内容：限制 stdout/stderr，使用 Schema 和字段长度校验，标题只作为 React 文本渲染，外链执行域名允许列表。
3. Profile 或账号在同步中切换导致跨账号缓存污染：捕获并显式传入 Profile，使用稳定账号/租户键隔离缓存，同步前后复核身份，变化时丢弃结果。

## 13. 测试策略

### 13.1 单元与合同测试

- 可执行文件缺失、版本过低、超时、取消、非零退出和输出上限。
- Windows 可执行文件/`.cmd`、Linux/macOS 路径与参数数组合同。
- JSON Schema 成功、未知字段、缺字段、无效 JSON 和超大响应。
- `auth status` 的已连接、未登录、失效和服务不可用分类。
- 三种 action 的完整分页、空页、重复页、部分失败和去重。
- 完成项 7 天边界、缺少可信完成时间和无效日期。
- 类型、状态、项目、URL 和稳定键归一化。
- Provider Registry 默认值、既有选择迁移、无效选择回退和原子保存失败。
- TAPD 与飞书项目缓存、账号身份和同步单飞隔离。
- 日志和 MCP 结果不包含凭据或业务内容。

测试使用假 CLI Runner 和脱敏合成 Fixture，不调用真实账号。

### 13.2 组件与浏览器测试

- 新用户默认展示飞书项目连接面板。
- 已保存 TAPD 的用户升级后仍展示 TAPD。
- 未安装展示安装命令；重新检测可恢复。
- 未登录、授权中、已连接、失效和离线状态可区分。
- Provider 切换保留各自缓存和连接状态。
- 全部项目自动出现在侧栏，侧栏只筛选、不控制同步。
- 只读卡片不可拖动，详情链接通过允许列表校验。
- Provider 选择和认证流程具备键盘、焦点、live region 与非颜色错误提示测试。
- 桌面和窄窗口无文字溢出或控件重叠。

### 13.3 真实 E2E

1. 在 Windows 安装官方 CLI，并设置 `project.feishu.cn`。
2. 从 FlowRivet 发起或按页面指引完成用户 OAuth。
3. `auth status` 和 `user me` 成功，FlowRivet 不出现 Token。
4. 同步 `this_week`、`overdue`、`done` 全部页面。
5. 将归一化任务 ID 数量与三条 CLI 原始命令脱敏核对。
6. 验证跨项目侧栏、重复项合并和最近 7 天完成过滤。
7. 切换到 TAPD 再切回飞书项目，两边数据和连接互不覆盖。
8. 模拟断网、Token 失效和 CLI 升级不兼容，验证缓存与错误状态。

真实验收记录不得保存 stdout、用户、项目、工作项或授权信息。

## 14. 准入与准出标准

### 14.1 准入

- 现有 Provider 中立项目、工作项、缓存和自动刷新测试通过。
- Node.js 满足官方 Meegle CLI 要求。
- 测试用户能访问至少一个飞书项目空间和个人工作视图。
- 飞书项目 MCP Server 可以保持关闭，验证流程不依赖远程 MCP。
- 没有真实账号时只完成自动化合同，不宣称真实 E2E 通过。

### 14.2 准出

- 新用户默认飞书项目，已有明确 Provider 选择不被覆盖。
- CLI 未安装、未登录、已连接、失效和离线状态正确区分。
- 用户可以按看板流程完成授权，FlowRivet 不保存或输出 Token。
- 三种 action 完整分页、稳定去重，并严格保留最近 7 天完成项。
- 看板结果与官方 CLI 在脱敏任务 ID 数量上核对一致。
- 自动聚合全部项目，不要求选择；项目侧栏筛选正确。
- TAPD 与飞书项目的连接、缓存、身份和同步互不污染。
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

探针若推翻认证、分页或必要字段假设，必须先更新本规格并重新审核，再继续实现。
