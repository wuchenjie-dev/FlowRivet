# FlowRivet 本地工作项通知设计

## 1. 背景

FlowRivet 已能在 Codex 中读取飞书项目个人待办，但用户必须打开看板后才能发现任务变化。MCP 服务端通知只在客户端保持连接时传递协议事件，不能可靠唤醒 Codex、创建对话消息或产生桌面未读提醒。因此通知能力不能建立在“MCP 主动推送消息给 Codex”的假设上。

本设计将事件检测放入本地 Companion，将 Codex MCP 保留为查询和交互入口。

## 2. 目标

- Companion 在后台按固定周期同步当前已连接账号的个人工作项。
- 检测新任务、排期变化、状态变化、即将到期和已逾期。
- 同一变化只生成一次事件和一次系统通知。
- Windows、macOS 和 Linux 使用统一通知接口，并允许平台不可用时安全降级。
- 看板显示未读数量和本地通知中心，支持打开原任务、单条已读和全部已读。
- 通知记录按 Provider 和稳定账号隔离。
- 提供 Provider 中立 MCP 工具，供看板和 Codex Automation 查询变化。

## 3. 非目标

- MCP 主动唤醒 Codex、创建对话消息或控制 Codex 系统通知。
- 飞书 Webhook、长连接、官方飞书项目 MCP 或远程推送服务。
- 在飞书项目中修改工作项。
- 评论、附件、描述正文或 GitLab 事件通知。
- 第一阶段提供复杂通知规则、按项目规则或组织级策略中心。
- 第一阶段自动创建 Codex Automation。

## 4. 用户决策

| 决策 | 结果 |
| --- | --- |
| 运行位置 | 本地 Companion |
| 默认轮询 | 60 秒 |
| 首次同步 | 只建立基线，不对现有任务集中通知 |
| 系统通知 | 新任务、状态变化、排期变化、即将到期、已逾期 |
| 即将到期窗口 | 24 小时 |
| 去重 | 账号 + 工作项 + 事件类型 + 变化指纹 |
| 事件保留 | 30 天；已读和未读均自动清理 |
| 看板入口 | 顶部通知图标和未读数 |
| Codex 汇总 | 后续通过 Automation 定时调用只读工具 |

## 5. 架构

```text
Companion lifecycle
  -> WorkItemNotificationMonitor (60s)
       -> ProviderRegistry + ActiveProviderStore
       -> ProviderAuthService
       -> shared WorkItemSynchronizer
       -> NotificationDiffEngine
       -> SqliteNotificationStore
       -> SystemNotifier

Codex / Taskboard
  -> list_work_item_notifications
  -> mark_work_item_notification_read
  -> mark_all_work_item_notifications_read
       -> SqliteNotificationStore
```

监控器复用进程级 `RuntimeServices`，不得构造第二套 CLI、Provider 或工作项缓存。后台同步和看板刷新使用相同 `WorkItemSynchronizer`，因此沿用现有按身份单飞语义。

## 6. 事件模型

公开事件只包含通知中心所需摘要：

```ts
interface WorkItemNotification {
  id: string;
  providerId: string;
  workItemKey: string;
  type: "assigned" | "status_changed" | "schedule_changed" | "due_soon" | "overdue";
  title: string;
  projectName: string;
  message: string;
  occurredAt: string;
  readAt?: string;
  externalUrl?: string;
}
```

`assigned` 表示基线建立后首次出现的活动工作项。已完成工作项不会产生 `due_soon` 或 `overdue`。`schedule_changed` 覆盖新增、修改和删除截止时间。`status_changed` 仅比较规范化阶段和 Provider 状态。

首次同步只保存基线，不生成事件，避免安装后一次弹出全部存量任务。

## 7. 去重与状态

监控状态按 `providerId + accountKey` 隔离，保存每个工作项用于比较的最小指纹：

- 工作项 Key
- 标题和项目名
- 规范化阶段
- Provider 状态
- 截止时间
- 外部链接
- 上次观察时间

事件去重键由账号命名空间、工作项 Key、事件类型和变化前后值的 SHA-256 指纹组成。数据库使用唯一约束保证 Companion 重启或并发同步不会重复写入。

`due_soon` 和 `overdue` 使用截止时间作为变化指纹。同一截止时间只各提醒一次；排期修改后允许针对新截止时间重新提醒。

## 8. 持久化

使用独立 SQLite 文件 `notifications.db`，不修改现有工作项缓存 Schema。平台目录沿用 FlowRivet 配置目录。

表：

- `notification_accounts`：稳定账号命名空间和最后成功扫描时间。
- `notification_items`：工作项比较基线。
- `notification_events`：事件、去重键和已读时间。

数据库目录权限为仅当前用户可访问；非 Windows 平台文件权限为 `0600`。每次成功扫描和通知列表读取时清理 30 天前事件。断开账号不删除历史事件，但切换账号后只展示当前账号的记录。

不保存飞书密码、Token、授权码、评论、附件、描述正文或 CLI 原始响应。

## 9. 系统通知适配器

定义窄接口：

```ts
interface SystemNotifier {
  notify(input: { title: string; message: string; externalUrl?: string }): Promise<void>;
}
```

默认实现直接调用 Windows、macOS 和 Linux 的原生通知命令，参数以 argv 传递且禁用 shell，避免引入存在已知安全公告的第三方通知依赖。任何随事件保存的 URL 必须是 `https:` 且主机为当前 Provider 的允许域名。第一阶段系统弹窗只负责提醒，不承诺跨平台点击回调；安全打开原任务统一由持久化通知中心提供。通知适配器失败只记录脱敏错误码，不回滚已持久化事件，也不终止监控循环。

系统不支持通知、用户关闭通知权限或处于无桌面会话时，通知中心仍正常工作。

## 10. 调度和失败恢复

- Companion 启动后等待一个完整周期再扫描，避免启动抖动。
- 同一时刻最多执行一次监控扫描。
- 未连接、CLI 缺失、授权过期时跳过扫描，等待下一周期。
- 普通同步失败保留原基线，不生成“任务消失”或虚假变化。
- 成功同步后用新快照和旧基线比较，并在同一数据库事务中写入事件与新基线。
- Companion 关闭时停止计时器；不阻塞正常退出。
- 轮询间隔第一阶段由环境变量 `FLOWRIVET_NOTIFICATION_INTERVAL_SECONDS` 覆盖，范围 30 至 3600 秒，默认 60 秒。普通用户界面配置留到后续。

## 11. MCP 工具

| 工具 | 行为 |
| --- | --- |
| `list_work_item_notifications` | 返回当前账号最近 30 天事件和未读总数，可按未读过滤 |
| `mark_work_item_notification_read` | 幂等标记单条事件已读 |
| `mark_all_work_item_notifications_read` | 幂等标记当前账号全部已读 |

工具只操作本地通知数据，不访问飞书。日志只记录 requestId、工具名、Provider、结果、耗时和数量，不记录账号、标题、项目、工作项 ID、URL 或消息正文。

Codex Automation 后续可周期调用 `list_work_item_notifications` 并仅在有未读高价值事件时生成对话提醒，但这属于 Codex 调度，不属于 MCP 服务端推送。

## 12. 看板交互

- 顶部增加铃铛图标；未读时显示稳定尺寸的数字徽标。
- 点击后打开右侧通知面板，不嵌套卡片。
- 每条通知显示类型、标题、项目和相对时间。
- 点击通知先标记已读，再打开经过验证的飞书原任务。
- 支持“全部已读”、空状态、加载失败和重试。
- 通知面板打开期间每 30 秒读取一次本地通知列表；看板关闭时不轮询 UI。
- 键盘可操作，关闭后焦点返回铃铛按钮；移动端面板占满可用宽度。

## 13. 安全与隐私

- 仅使用稳定账号 Key 做隔离，不使用显示名作为身份边界。
- 不将账号 Key、任务标题或 URL 写入日志。
- 系统通知正文只显示任务标题和变化摘要；后续可增加隐私模式。
- 外部链接必须通过 Provider 域名白名单校验。
- 所有工具保持本地、最小权限；不增加飞书写接口。

## 14. 测试策略

- 差异引擎：首次基线、五类事件、完成项、排期删除、重复扫描和时间边界。
- Store：账号隔离、唯一去重、事务更新、已读、全部已读、30 天清理和文件权限。
- Monitor：未连接跳过、同步失败保留基线、单飞、适配器失败降级和停止。
- 系统通知：通过假适配器验证，不在 CI 弹真实通知。
- MCP：工具契约、身份隔离、幂等、稳定错误和日志脱敏。
- React：未读徽标、面板、已读、全部已读、链接验证、焦点和移动端布局。
- E2E：使用合成事件，不依赖真实飞书数据或操作系统通知中心。

## 15. 准入标准

- 飞书项目 Provider、稳定账号身份和共享同步器已经可用。
- 工作项包含稳定 Key、阶段、排期和经过验证的外部链接。
- Companion 生命周期能够安全启动和停止后台组件。
- 看板维持只读边界。

## 16. 准出标准

- 首次扫描不产生通知，后续五类变化能准确生成且不重复。
- Companion 重启后仍能继续去重。
- 当前账号通知不会泄漏到其他账号。
- 系统通知失败不影响本地通知中心或任务同步。
- Windows、macOS 和 Linux 使用同一接口并具有明确降级行为。
- 看板显示未读数，支持单条和全部已读以及安全打开飞书原任务。
- MCP 工具不能主动唤醒 Codex，文档不宣称具备该能力。
- 单元、契约、类型、构建和浏览器测试全部通过。
