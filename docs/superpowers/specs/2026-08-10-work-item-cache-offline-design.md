# 工作项缓存与离线降级设计

## 1. 背景

FlowRivet Phase 1C 已能在 Codex 中实时聚合当前 TAPD 用户的需求、任务和缺陷，并按需读取详情。当前看板只保留内存状态：Companion 重启、TAPD 暂时不可用或 Token 失效后，用户无法继续查看上次已成功同步的待办。

本阶段增加 Provider 中立的 SQLite 工作项缓存和离线降级。缓存是后续 60 秒自动刷新的前置能力，但本阶段不实现轮询，也不恢复已取消的拖拽回写。

## 2. 目标

- Companion 重启后可以恢复最近一次有效看板。
- TAPD 全部不可用时展示明确标记的离线快照，不伪装为空成功。
- 部分“项目 + 工作项类型”同步失败时，用该范围的旧缓存补齐结果。
- Token 失效时保留只读缓存看板，并允许用户主动重新登录。
- 断开账号或切换账号时删除旧账号缓存。
- 每个同步范围超过自身最后成功同步时间 7 天后自动删除。
- 保持 Provider 中立、只读、日志脱敏和本机凭据边界。

## 3. 本阶段不包含

- 60 秒自动刷新、后台定时器或可见性轮询。
- 拖拽、状态映射、TAPD 状态回写或任何离线写入。
- 工作项详情、描述、评论、附件或 Token 的持久化。
- 多企业同时聚合或多 Provider 同时启用。
- SQLite 加密、云端同步或跨设备恢复。

## 4. 已确认产品决策

- 缓存以“Provider + 账号 + 企业”为命名空间。
- 同步范围以“项目 + Provider 工作项类型”为最小替换单元。
- 成功范围使用最新数据；失败范围保留旧数据并标记为缓存数据。
- 离线或 Token 失效时保留看板，顶部展示离线横幅和重新连接入口。
- 缓存只保存看板摘要和同步元数据，不保存详情描述。
- 断开账号先清理缓存，再删除 Token；清理失败时不得虚假报告断开成功。
- 缓存按同步范围独立计算有效期；范围最后成功同步超过 7 天后自动删除。

## 5. 架构

```text
MCP Tool / React UI
        |
Taskboard Snapshot Orchestrator
        |
WorkItemService ---------------- WorkItemCacheStore
        |                               |
WorkItemProvider                  SqliteWorkItemCacheStore
        |                               |
TapdWorkItemProvider              flowrivet.db
```

`WorkItemCacheStore` 是 Provider 中立端口。业务服务只处理账号命名空间、同步范围和归一化工作项，不读取 TAPD 响应结构，也不直接执行 SQL。

SQLite 适配器使用 Node 22.5 起提供的内置 `node:sqlite`。这避免在 Codex 插件中分发按操作系统编译的第三方二进制依赖。项目 `engines.node` 同步收紧为 `>=22.5`；运行时仍做能力检测，若缺少 `node:sqlite`，在线同步可以使用，但缓存返回稳定的不可用错误。

数据库路径沿用 FlowRivet 配置目录：

- Windows：`%LOCALAPPDATA%\FlowRivet\flowrivet.db`
- macOS：`~/Library/Application Support/FlowRivet/flowrivet.db`
- Linux：`$XDG_CONFIG_HOME/flowrivet/flowrivet.db`，未设置时使用 `~/.config/flowrivet/flowrivet.db`

## 6. Provider 同步合同

当前 Provider 以项目为单位返回聚合数据和 `failedKinds`，无法安全地区分可替换的缓存范围。本阶段改为显式范围结果：

```ts
interface WorkItemScopeResult {
  providerItemType: string;
  kind: WorkItemKind;
  outcome: "success" | "error";
  items: WorkItem[];
  errorCode?: "provider_unauthorized" | "provider_unavailable" | "work_item_sync_failed";
}

interface WorkItemQueryResult {
  projectExternalId: string;
  scopes: WorkItemScopeResult[];
}
```

每个 Provider 必须为本次请求的所有支持类型返回一个范围结果。失败范围的 `items` 必须为空；服务层不得根据缺失数组元素猜测成功。

TAPD 首个实现固定返回 `story`、`task`、`bug` 三个范围。需求、任务或缺陷任一接口失败，只影响对应范围。身份失效属于项目级授权失败，可使所有范围失败，但不能覆盖旧缓存。

## 7. 缓存端口

```ts
interface WorkItemCacheStore {
  activateAccount(input: CacheAccount): Promise<void>;
  mergeScopes(input: CacheMergeInput): Promise<CachedSnapshot>;
  loadActive(providerId: string, now: Date): Promise<CachedSnapshot | undefined>;
  clearActive(providerId: string): Promise<void>;
  purgeExpired(now: Date): Promise<number>;
}
```

- `activateAccount` 以账号和企业身份的稳定哈希作为命名空间键。哈希输入不写入日志。
- 内部认证身份必须保留 TAPD `id` 或 `nick` 作为稳定账号键，并优先组合 `companyId`；公开 `AuthResult` 仍只返回显示名称，不暴露稳定标识。
- Provider 无法返回稳定账号键时，在线同步继续但缓存返回 `cache_identity_unavailable`，不得退化为用显示名称隔离账号。
- 活动账号发生变化时，先删除旧命名空间，再激活新命名空间。
- `mergeScopes` 在单个事务内替换所有成功范围，失败范围保持不变。
- `loadActive` 只返回当前 Provider 的活动命名空间；读取前按每个范围的 `last_success_at` 删除超过 7 天的范围，再删除没有范围的孤立项目和账号。
- `clearActive` 在一个事务内删除活动指针、账号、项目、范围和工作项。
- `mergeScopes` 写事务失败时不得吞掉本次已获得的在线结果：服务返回本次成功范围，缺失的失败范围不补缓存，并附加 `cache_write_failed`。
- 缓存内部保存不含 `freshness` 的 Provider 中立工作项摘要；写入前剥离派生来源字段，读取后再标记为 `cached`，本次同步结果标记为 `fresh`。
- 所有输出重新通过 Zod Provider 中立 Schema；无效行不得进入 UI。

## 8. SQLite 数据结构

数据库使用显式 schema version，首个版本包含：

### 8.1 `cache_accounts`

- `namespace_key`：SHA-256 稳定哈希，主键。
- `provider_id`。
- `account_display_name`、`tenant_display_name`：仅用于离线连接状态展示。
- `last_success_at`：该账号任一范围最近一次成功同步时间，仅用于离线状态展示，不作为范围保留期依据。
- `is_active`：同一 Provider 最多一条活动记录。

数据库必须用部分唯一索引落实“同一 Provider 最多一个活动账号”，不能只依赖应用层检查。

### 8.2 `cache_projects`

- `namespace_key`。
- `project_external_id`。
- `project_json`：经过 `ProjectRef` Schema 验证的 JSON。
- 组合主键为 `namespace_key + project_external_id`。

### 8.3 `cache_scopes`

- `namespace_key`。
- `project_external_id`。
- `provider_item_type`。
- `kind`。
- `last_success_at`。
- 组合主键为 `namespace_key + project_external_id + provider_item_type`。

### 8.4 `cache_items`

- `namespace_key`。
- `project_external_id`。
- `provider_item_type`。
- `item_key`。
- `item_json`：经过缓存工作项 Schema 验证的 JSON，不包含详情描述，也不持久化 `freshness`；读取时补为 `cached` 后再通过 `WorkItem` Schema。
- 组合主键为同步范围加 `item_key`。

外键使用级联删除。成功同步一个空范围时仍更新 `cache_scopes`，并删除该范围旧工作项，避免已完成、转派或删除的工作项残留。过期清理以 `cache_scopes.last_success_at` 为准：单个范围持续成功不得延长其他失败范围的寿命；清理范围后同步删除孤立项目，账号没有任何有效范围时删除账号和活动指针。

数据库初始化、版本检查、范围替换和过期清理都使用事务。未知高版本、迁移失败或损坏数据库不自动删除文件。默认使用 SQLite `DELETE` journal mode，避免产生权限未落实的持久 WAL sidecar；若实现改用其他 journal mode，必须对数据库及 sidecar 文件同时落实 Unix `0600` 权限。

## 9. 快照合同

工作项增加数据来源：

```ts
freshness: "fresh" | "cached"
```

看板快照增加：

```ts
dataFreshness: "live" | "mixed" | "offline";
staleScopeCount: number;
lastSuccessfulSyncAt?: string;
lastSyncAttemptAt: string;
cacheWarningCode?: "cache_unavailable" | "cache_identity_unavailable" | "cache_read_failed" | "cache_write_failed";
freshnessReasonCode?: "provider_unauthorized" | "provider_unavailable" | "work_item_sync_failed";
```

稳定账号键和企业键只在服务内部用于计算命名空间，不进入快照。

现有 `lastSyncedAt` 保留以兼容 UI，其语义固定为最近一次成功写入 Provider 数据的时间。`lastSyncAttemptAt` 表示本次读取尝试时间，两者不得混用。

`dataFreshness` 判定：

- `live`：所有返回范围都来自本次成功同步。
- `mixed`：至少一个范围为本次成功数据，且至少一个范围来自旧缓存。
- `offline`：没有范围在本次成功，全部展示数据来自缓存。

无缓存且全部在线范围失败时，继续返回现有 `work_item_sync_failed`，不得返回离线空看板。

## 10. 数据流

### 10.1 在线成功

1. 验证 Token 和当前身份。
2. 计算账号命名空间并激活。
3. 自动发现全部可访问项目。
4. Provider 返回每个项目和类型的范围结果。
5. 服务层在事务内替换成功范围，保留失败范围。
6. 从事务结果组装统一快照，执行最近 7 天完成项过滤和稳定排序。
7. UI 展示 `live` 或 `mixed` 状态。

### 10.2 Token 失效或 Provider 不可用

1. 连接检查返回 `expired`、`provider_unauthorized` 或暂时不可用错误。
2. Orchestrator 从活动账号命名空间读取未过期缓存。
3. 存在缓存时返回 `offline` 快照，并保留真实连接状态。
4. 不存在缓存或缓存已超过 7 天时，展示登录或同步错误状态。

### 10.3 重新登录

- 登录采用两阶段提交：先用候选 Token 验证身份，但不写凭据存储；身份验证成功后再决定缓存切换，最后以原子替换持久化候选 Token。
- 同一账号登录时保留当前缓存，持久化新 Token 后立即执行在线同步。
- 登录到不同账号时，先成功删除旧活动缓存和项目选择，再持久化新 Token 并激活新命名空间。
- 旧 Token 在所有清理步骤完成前保持不变；任一清理步骤失败时不写入候选 Token，并返回对应清理错误。此前已经成功删除的本地数据不做跨存储回滚，但旧身份仍然有效且可重新同步。
- 候选 Token 原子替换失败时保留旧 Token，且不得激活新命名空间；已经删除的旧缓存或项目选择不做不安全恢复，返回现有凭据错误。
- 缓存、项目选择和凭据不宣称具备跨存储原子事务；安全不变量是“新身份永远不能读取旧身份缓存”，恢复本地数据依赖旧身份下一次在线同步。
- 成功范围更新后，其卡片从 `cached` 变为 `fresh`。

### 10.4 主动断开

1. 读取当前活动账号键。
2. 删除该账号全部缓存和活动指针。
3. 缓存删除成功后再删除 DPAPI Token。
4. 缓存删除失败时返回 `cache_clear_failed`，保留 Token 供用户重试。
5. Token 删除失败时返回现有凭据错误；缓存已经删除，不进行不安全恢复。

## 11. UI

- `live`：沿用当前看板，不增加常驻说明。
- `mixed`：主区顶部显示非阻塞警告，说明部分数据来自缓存并显示过期范围数量。
- `offline`：顶部显示明确的离线横幅、最后成功同步时间和“重新连接”按钮。
- `cached` 工作项显示紧凑缓存标记；不改变卡片尺寸和列宽。
- “重新连接”打开可关闭的 Token 登录对话框。关闭后仍可浏览缓存摘要。
- 离线点击卡片可以打开详情抽屉，但详情工具失败时显示“重新连接后加载详情”，不缓存或伪造描述。
- 缓存超过 7 天或主动断开后，没有数据时显示正常登录页。
- 删除登录页中过期的“Phase 1A Demo 数据”文案。
- 桌面和移动端不得产生横向溢出、内容遮挡或焦点逃逸。

## 12. 安全与隐私

- Token、Authorization、OAuth 数据、详情描述、评论和附件不得写入 SQLite。
- SQLite 包含项目和工作项业务摘要，必须只位于当前用户配置目录。
- Linux/macOS 创建配置目录权限为 `0700`，数据库文件权限为 `0600`；Windows 使用当前用户配置目录 ACL。
- 账号命名空间键使用 `providerId + tenant identity + account identity` 的 SHA-256，不把原始组合键写入日志。
- `account identity` 使用 Provider 返回的稳定用户 `id`，缺失时使用 Provider 明确声明唯一的 `nick`；不得使用可变的显示姓名。`tenant identity` 优先使用 `companyId`，缺失时使用稳定空值占位并依赖 Provider 全局用户键隔离。
- SQL 全部使用绑定参数，不拼接 Provider、项目、类型或工作项字段。
- 缓存返回值必须经过 Zod 验证；无效 JSON 视为缓存读取失败。
- 断开账号后的缓存清理属于用户可见安全承诺，失败必须显式返回。

## 13. 错误处理

| 场景 | 行为 |
|---|---|
| `node:sqlite` 不可用 | 在线同步继续，返回 `cache_unavailable` 警告 |
| Provider 身份缺少稳定账号键 | 在线同步继续，返回 `cache_identity_unavailable`，不读写缓存 |
| 建库、迁移或读取失败 | 不删除数据库；在线同步继续，离线缓存不可用 |
| 缓存写入失败 | 返回最新在线数据和 `cache_write_failed`，不声称已持久化 |
| 缓存合并事务失败且有失败范围 | 返回本次成功范围和 `cache_write_failed`，不使用未确认的旧范围 |
| 部分范围失败且有缓存 | 合并旧范围，返回 `mixed` |
| 部分范围失败且无缓存 | 返回其他最新数据和现有部分失败警告 |
| 全部范围失败且有缓存 | 返回 `offline` |
| 全部范围失败且无缓存 | 返回 `work_item_sync_failed` |
| 缓存超过 7 天 | 事务删除并按无缓存处理 |
| 缓存清理失败 | 返回 `cache_clear_failed`，不删除 Token |
| 缓存行 Schema 无效 | 当前缓存读取失败，不把无效数据传给 UI |

缓存错误不得被包装成“0 个待办”。缓存读写不自动无限重试；后续手动刷新或重新打开可以再次尝试。

## 14. 可观测性

同步日志可增加：

- `dataFreshness`
- `freshScopeCount`
- `staleScopeCount`
- `cacheOutcome`：`hit`、`miss`、`write_success`、`write_error`、`purged`
- 稳定缓存错误码

禁止记录账号、企业、项目 ID、项目名称、工作项 ID、标题、缓存路径、输入 JSON、SQL 参数或响应正文。每次 MCP 工具调用继续使用同一个 `requestId` 串联同步和缓存结果。

## 15. 测试策略

### 15.1 Store 合同与 SQLite

- 首次建库和重复初始化。
- schema version 检查与未知高版本拒绝。
- 成功范围完整替换、成功空范围删除旧项。
- 失败范围保留、账号和 Provider 隔离。
- 活动账号切换和级联删除。
- 7 天边界、过期清理和时钟注入。
- 不同范围独立过期；一个范围成功不得延长另一个范围寿命。
- 过期范围、孤立项目及无有效范围账号的级联清理。
- 事务失败不留下半写状态。
- 损坏数据库、无效 JSON 和权限失败。
- Windows、Linux、macOS 路径与 Unix 权限合同。

### 15.2 同步服务

- 全新在线数据返回 `live`。
- 成功范围与旧范围合并返回 `mixed`。
- 全部失败且有缓存返回 `offline`。
- 全部失败且无缓存抛出稳定错误。
- 缓存写入失败仍返回在线数据和警告。
- 最近 7 天完成项过滤同时作用于新数据和缓存数据。
- 并发同步继续复用同一个 in-flight Promise。

### 15.3 MCP 与认证

- Token 失效、Provider 不可用时读取活动缓存。
- 稳定身份键只用于缓存命名空间，不进入 MCP 输出和日志。
- 同账号和跨账号重新登录。
- 候选 Token 验证、缓存切换和凭据持久化的两阶段顺序。
- 跨账号任一步骤失败时保留原 Token 和原身份，新身份不得读取旧缓存。
- 断开时先清缓存再删 Token。
- 缓存清理失败不得报告断开成功。
- MCP 输出 Schema、只读注解和日志脱敏。

### 15.4 UI 与浏览器

- `live`、`mixed`、`offline` 三种状态。
- 缓存卡片标记、过期范围数量、最后同步时间。
- 重新登录对话框、关闭后继续浏览、登录成功后恢复在线。
- 离线详情错误、缓存过期登录页和过期 Demo 文案移除。
- 桌面、移动端、键盘与无横向溢出。

### 15.5 真实只读探针

- 使用真实 TAPD 只读同步写入一个临时数据库。
- 停止并重启测试 Companion 后恢复快照。
- 探针只输出成功、缓存命中、数据新鲜度、范围计数和字段存在布尔值。
- 不输出账号、项目、工作项身份、标题、URL、Token、描述或数据库内容。

## 16. 准入标准

- Phase 1C 真实只读看板和详情抽屉在 `main` 可运行。
- Node.js 22.5 或更高版本，并确认目标运行时提供 `node:sqlite`。
- TAPD 身份接口可返回 `id` 或 `nick` 稳定账号键；缺失时按无缓存能力处理。
- 现有工作项 Provider 可以暴露每个类型的独立成功或失败结果。
- 测试使用临时数据库，不读取或删除用户真实缓存。
- 本阶段不注册任何 TAPD 写工具。

## 17. 准出标准

- Companion 重启后可恢复 7 天内的最近有效看板。
- 部分同步失败按“项目 + Provider 工作项类型”正确合并新旧数据。
- Token 失效或 Provider 不可用时，有缓存则返回明确的离线看板，无缓存则保持原错误行为。
- 离线、混合和在线状态在 MCP 合同及 UI 中可区分，缓存卡片可识别。
- 重新登录可恢复在线同步；主动断开会删除活动账号全部缓存。
- 每个范围超过自身最后成功同步时间 7 天后自动删除且不再展示，不受其他范围成功同步影响。
- 缓存故障不阻断有效在线数据，也不伪装成成功持久化。
- Token 和详情内容不进入 SQLite、日志、MCP 响应或测试产物。
- 单元、合同、类型检查、生产构建、Playwright 和真实只读缓存恢复探针全部通过。

## 18. 后续阶段

缓存和同步观测稳定后，单独设计 60 秒自动刷新：同一时刻复用同步、组件不可见时暂停、恢复可见时条件刷新，并验证不会造成请求风暴。拖拽和 TAPD 状态回写继续保持关闭，除非用户重新确认范围。
