# FlowRivet 看板可配置自动刷新设计

## 1. 背景

FlowRivet 已具备真实 TAPD 只读同步、手动刷新、Provider 中立工作项缓存，以及混合/离线降级。下一阶段增加看板打开期间的自动刷新，使用户无需重复点击刷新即可获得较新的待办数据。

自动刷新仍然保持只读。拖拽、状态映射和 TAPD 状态回写继续关闭，除非用户重新确认独立范围。

## 2. 目标

- 用户可以在看板账号菜单中配置全局自动刷新频率。
- 支持不刷新、5 秒、10 秒、30 秒、60 秒和自定义秒数。
- 自定义值必须是 `5～3600` 的整数秒。
- 首次使用默认 60 秒。
- 页面不可见时不启动新刷新；恢复可见时按已过去时间决定立即刷新或等待剩余时间。
- 手动、自动和恢复可见刷新共用单飞语义，不产生并发请求风暴。
- 网络或 Provider 失败保留当前实时、混合或离线看板；Token 失效时暂停自动刷新。
- 配置跨 Codex 任务和 Companion 重启恢复，且不与 TAPD 或其他项目管理 Provider 耦合。

## 3. 非目标

- Companion 在没有打开看板时后台轮询。
- 服务端主动推送、WebSocket、SSE 或跨看板实例广播。
- 指数退避、随机抖动或动态速率算法。
- 按账号、租户、Provider 或项目保存不同刷新频率。
- 取消已经发出的 TAPD 请求。
- 缓存工作项详情、评论或附件。
- 拖拽、状态映射、TAPD 状态回写或任何离线写入。

## 4. 用户决策

| 决策 | 结果 |
| --- | --- |
| 配置范围 | 本机全局，所有账号和项目共用 |
| 预设值 | 不刷新、5、10、30、60 秒 |
| 自定义范围 | 5～3600 整数秒 |
| 默认值 | 60 秒 |
| 恢复可见 | 到期立即刷新，否则等待剩余时间 |
| 普通失败 | 等待下一个正常周期 |
| 未连接或 Token 失效 | 暂停，重新连接成功后恢复 |
| 配置入口 | 顶部账号/连接菜单 |

## 5. 架构

```text
ConnectionMenu
  -> get_taskboard_preferences
  -> save_taskboard_preferences
          |
          v
TaskboardPreferencesService
          |
          v
JsonTaskboardPreferencesStore
          |
          v
taskboard-preferences.json

App refresh coordinator
  -> Page Visibility API
  -> one in-flight refresh promise
  -> refresh_my_work_items
          |
          v
Companion process-level shared WorkItemSynchronizer
  -> existing WorkItemService + cache merge
```

计时器属于当前 React 看板页面。Companion 只负责校验和持久化偏好，不在后台调度 TAPD 请求。这样看板关闭后不会继续占用 TAPD 配额，也不需要增加服务端推送协议。

当前 HTTP 入口会为每次 MCP 请求创建新的 Server，因此不能依赖请求内新建的 `WorkItemService` 实现跨看板单飞。Companion 启动时必须创建一个进程级共享 `WorkItemSynchronizer`，再注入每个请求级 MCP Server。请求级 Server 和 Transport 仍按现有方式创建和关闭。

进程级单飞必须按同步身份隔离。同步键由 `providerId`、稳定 `accountKey`、`tenantKey` 和排序后的可用项目 ID 集合组成；只有同步键完全相同的手动或自动刷新才能复用进行中的 Promise。账号、租户或项目集合任一不同，都必须启动独立同步，绝不能返回另一身份的结果。同步键只存在内存中，不写入日志、偏好文件或 UI；缺少稳定 `accountKey` 时不得参与跨请求单飞。

## 6. Provider 中立偏好模型

公开契约：

```ts
interface TaskboardPreferences {
  refreshIntervalSeconds: number;
}
```

约束：

- `0` 表示不自动刷新。
- 非零值必须是 `5～3600` 的整数。
- 契约不包含 `tapd`、账号、租户或项目字段。
- 默认值是 `{ refreshIntervalSeconds: 60 }`。

持久化 Envelope：

```json
{
  "version": 1,
  "preferences": {
    "refreshIntervalSeconds": 60
  }
}
```

平台路径：

- Windows：`%LOCALAPPDATA%\FlowRivet\taskboard-preferences.json`
- macOS：`~/Library/Application Support/FlowRivet/taskboard-preferences.json`
- Linux：`$XDG_CONFIG_HOME/flowrivet/taskboard-preferences.json`，未设置时为 `~/.config/flowrivet/taskboard-preferences.json`

Store 使用临时文件加原子重命名。文件不存在时返回默认值 60 秒；JSON 损坏、版本未知、Schema 不合法或 I/O 失败时返回稳定错误，不覆盖原文件。UI 收到读取错误时必须在本次会话采用 `0`，不得用首次默认值重新启用网络请求。

偏好文件不保存 Token、身份、项目、工作项或 URL。断开或切换 TAPD 账号不删除全局刷新偏好。

## 7. MCP 工具

新增两个 Provider 中立工具：

| 工具 | 属性 | 行为 |
| --- | --- | --- |
| `get_taskboard_preferences` | 只读、本地 | 返回已保存偏好；文件不存在时返回默认值 |
| `save_taskboard_preferences` | 写本地配置、不访问网络 | 校验并原子保存完整偏好，然后返回最终值 |

稳定错误码：

- `taskboard_preferences_read_failed`
- `taskboard_preferences_write_failed`
- `taskboard_preferences_invalid`

工具日志只记录 requestId、工具名、结果、耗时和最终间隔秒数。不得记录 Token、身份、项目或工作项内容。

偏好写入和 TAPD 刷新是独立事务。保存频率成功不隐式调用 TAPD；UI 在收到成功结果后重新安排计时器。保存失败时 UI 保留上一次已确认值。

## 8. 前端刷新协调器

`App` 内增加独立刷新协调逻辑，统一处理四类触发源：

- 用户点击手动刷新。
- 自动计时到期。
- 页面恢复可见且间隔已经到期。
- 登录或重新连接成功后的立即刷新。

协调器维护：

```ts
interface RefreshCoordinatorState {
  intervalSeconds: number;
  lastAttemptCompletedAt?: number;
  inFlight?: Promise<void>;
  rateLimitUntil?: number;
}
```

`lastAttemptCompletedAt` 是客户端本次刷新尝试完成的单调时间基准，不使用 `lastSuccessfulSyncAt` 或服务端 `lastSyncAttemptAt` 计算下一次计时。原因是失败尝试也必须重置周期，且服务端时间可能来自离线缓存或与客户端时钟不同。

所有触发源调用同一 `requestRefresh()`：

1. 已有请求时复用 `inFlight`，不发送第二个工具调用。
2. 调用现有 `refresh_my_work_items`。
3. 成功时应用新快照；失败时保留当前可用快照并显示现有错误状态。
4. 在 `finally` 中记录尝试完成时间、清除 `inFlight`，再根据最新配置和可见性安排下一周期。

手动刷新同样重置周期，避免用户刚手动刷新后自动计时立即再次触发。

## 9. 可见性与连接状态机

### 9.1 页面隐藏

- 收到 `visibilitychange` 且 `document.visibilityState !== "visible"` 时取消待执行计时器。
- 已经发出的请求允许完成，但完成后不安排新计时器。
- 隐藏期间不累计补偿次数。

### 9.2 恢复可见

- `intervalSeconds === 0`：不执行任何自动刷新。
- 未连接或 Token 已失效：保持暂停。
- 没有 `lastAttemptCompletedAt`：从恢复时刻开始等待完整周期；登录成功属于独立的立即刷新触发。
- 已过去时间大于等于配置周期：立即请求一次刷新。
- 否则只等待剩余时间。

### 9.3 连接变化

- `connected`：允许安排自动刷新。
- `disconnected` 或 `expired`：取消计时器，不持续调用 Provider。
- 重新登录成功：立即调用一次刷新；完成后恢复周期。
- 断开连接：取消计时器，保留全局偏好。

### 9.4 Provider 限流

- TAPD Adapter 将 HTTP `429` 映射为 Provider 中立错误 `provider_rate_limited`，不得混入普通同步失败。
- 若上游提供合法 `Retry-After`，支持整数秒和 HTTP 日期格式，换算后限制为 `1～86400` 秒；超出范围或无法解析时使用 60 秒。
- 同一次聚合同步中多个范围被限流时，使用最长的合法等待时间。
- 同步快照可选返回 `retryAfterSeconds`，仅在 `freshnessReasonCode === "provider_rate_limited"` 时存在。
- UI 设置 `rateLimitUntil`，下一次自动刷新时间不得早于该时刻，也不得早于用户配置周期。
- 如果全部范围失败而 MCP 只能返回稳定错误码、无法携带等待时间，UI 使用 60 秒冷却。
- 手动刷新仍允许用户主动触发；手动请求再次收到限流时重新计算冷却期。

## 10. 错误处理

| 场景 | 行为 |
| --- | --- |
| 普通网络/API 错误 | 保留当前看板和错误提示，从失败完成时间等待下一个周期 |
| Provider 返回 HTTP 429 | 保留当前看板，按合法 `Retry-After` 或默认 60 秒暂停自动刷新 |
| 部分范围失败 | 使用现有缓存合并返回混合看板，继续正常周期 |
| 全部失败但有缓存 | 显示离线缓存，普通 Provider 错误继续正常周期 |
| Token 失效/未连接 | 显示离线或登录状态并暂停自动刷新 |
| 偏好文件不存在 | 首次使用默认 60 秒 |
| 偏好读取失败 | 本次会话使用 0 秒关闭自动刷新，显示非阻塞设置警告 |
| 偏好写入失败 | 保留旧值和原计时安排，显示设置保存失败 |
| 非法自定义值 | 前端阻止提交，服务端再次返回 `taskboard_preferences_invalid` |

自动刷新错误不得清空已有卡片，不得把失败包装为“0 个待办”，也不得自动无限快速重试。

## 11. 界面与可访问性

账号/连接菜单增加“自动刷新”分组：

- 不刷新
- 5 秒
- 10 秒
- 30 秒
- 60 秒
- 自定义

当前选择使用勾选图标和可访问选中状态，不只依赖颜色。自定义值保存后显示为“自动刷新：N 秒”。

“自定义”打开紧凑对话框：

- 使用数字输入，步长 1，最小 5，最大 3600。
- 只接受整数；错误与输入建立可访问关联。
- 支持焦点陷阱、`Escape` 关闭和关闭后焦点恢复。
- 保存期间禁用重复提交；成功后关闭并重排计时器。

自动刷新进行中复用现有刷新按钮忙碌状态和最后同步区域，不增加遮挡看板的通知。设置警告使用非阻塞状态区域。

桌面和移动端菜单、对话框不得造成页面横向溢出。

## 12. 多实例语义

多个 Codex 看板可以同时打开，但本阶段不增加跨页面偏好广播。每个页面在启动时读取一次偏好，并在本页面保存成功后使用新值。另一个已打开页面不会立即感知修改，重新打开后读取最新值。

每个页面具有自己的 UI 单飞锁；Companion HTTP 服务在进程启动时创建并共享同一个 `WorkItemSynchronizer`，以合并同一进程内来自不同页面和 MCP 请求的并发同步。请求级 MCP Server 不得自行创建新的默认同步器。跨进程 Companion 不在本阶段协调。

## 13. 测试策略

### 13.1 Store 与契约

- 默认 60 秒、`0`、预设值和自定义边界。
- 拒绝负数、1～4、3601、浮点数、字符串和未知字段。
- 文件不存在返回默认值。
- 损坏文件和 I/O 读取失败在 UI 中关闭本次会话自动刷新，不得回退到 60 秒。
- 跨 Store 实例恢复配置。
- 原子写入失败不破坏旧配置。
- 损坏 JSON、未知版本和 I/O 错误返回稳定错误。

### 13.2 MCP 与日志

- 工具注册和只读/本地写属性。
- 读取默认值、保存并再次读取。
- 无效输入和 Store 失败映射到稳定错误码。
- 日志只有白名单字段，不含凭据或业务数据。
- 保存偏好不调用 TAPD Provider。
- HTTP 请求级 MCP Server 共享同一个进程级同步器；相同同步键的并发刷新只调用一次 Provider。
- 不同账号、租户或项目集合的并发刷新互不复用结果；缺少稳定账号标识时不跨请求合并。
- HTTP `429` 映射为 `provider_rate_limited`，日志不记录上游响应正文。

### 13.3 React 单元测试

使用假计时器覆盖：

- 默认 60 秒以及 5、10、30、60 秒预设。
- 自定义 5 和 3600 秒边界。
- 不刷新时没有自动工具调用。
- 自动、手动和恢复可见触发单飞。
- 手动刷新重置自动周期。
- 页面隐藏暂停，恢复时到期立即刷新或等待剩余时间。
- 普通失败等待下一周期。
- 限流优先遵守合法 `Retry-After`，非法或缺失时冷却 60 秒。
- Token 失效暂停，重新连接后立即刷新并恢复周期。
- 配置保存失败保留旧选择。
- 组件卸载清理计时器和事件监听。

### 13.4 Playwright

- 桌面和移动端打开账号菜单并选择预设。
- 自定义对话框验证范围、整数、键盘焦点和焦点恢复。
- 假时间或短间隔 Harness 验证自动刷新调用。
- 页面可见性场景验证不会重复调用。
- 菜单、状态和对话框无横向溢出。

## 14. 准入标准

- Provider 中立工作项同步、手动刷新和单飞已经稳定。
- SQLite 缓存与混合/离线降级已经通过真实重启探针。
- 连接状态能区分 `connected`、`disconnected` 和 `expired`。
- Node.js 版本不低于 22.5。
- 不恢复拖拽或任何 TAPD 写接口。

## 15. 准出标准

- 用户可保存不刷新、四个预设或 `5～3600` 自定义整数秒，重启后恢复。
- 首次默认 60 秒。
- 偏好文件读取失败时本次会话关闭自动刷新，不覆盖原文件。
- 页面隐藏期间不产生新自动刷新请求。
- 恢复可见时只在到期后立即刷新，否则等待准确剩余时间。
- 手动、自动、恢复触发和多个已打开看板在同一 Companion 进程内不会形成并发请求风暴。
- 普通错误等待下一周期；Token 失效暂停到重新连接。
- Provider 限流按合法 `Retry-After` 或默认 60 秒冷却，不按 5 秒配置持续请求。
- 实时、混合和离线快照在刷新失败时均不会被清空。
- 配置文件、MCP 响应、日志和发布包不含 Token 或工作项业务内容。
- 单元、合同、类型检查、生产构建和 Playwright 全部通过。
- 没有新增 TAPD 写工具、服务端后台轮询、推送通道或详情持久化。

## 16. 后续阶段

自动刷新稳定并取得真实请求频率数据后，再评估是否需要指数退避、随机抖动或跨页面广播。拖拽和 TAPD 状态回写仍需用户单独重新确认范围并形成新的设计规格。
