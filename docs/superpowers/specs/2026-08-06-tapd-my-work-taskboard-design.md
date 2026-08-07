# TAPD 我的待办看板设计

## 1. 背景与目标

FlowRivet 的第一个产品需求是在 Codex 中提供“我的 TAPD 待办”看板。看板聚合当前 TAPD 用户在多个项目中负责的未完成需求、任务和缺陷，并展示最近 7 天完成的工作项。用户可以在统一看板中查看、筛选和拖动工作项；拖动必须回写 TAPD。

本需求参考 [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) 的本地看板、CLI 和 Codex 协作方式，但不复制其 CDP 注入、CSP 绕过或 Codex 私有 DOM 修改。FlowRivet 使用 Codex 官方插件与 MCP Apps UI：MCP 工具返回 UI Resource，React 组件通过 MCP Apps bridge 调用工具。

## 2. 用户价值

- 用户不需要逐个打开 TAPD 项目即可扫描自己的工作。
- 不同项目、需求、任务和缺陷被归一化为一致的四阶段工作流。
- Codex 与用户共享同一组 MCP 工具，既能显示看板，也能在对话中查询或推进工作项。
- TAPD 个人 Token 由本地 Companion 验证，并使用操作系统保护能力加密保存，为后续访问内网 GitLab 保留本地数据平面。

## 3. 已确认范围

### 3.1 第一版包含

- 当前用户负责的未完成需求、任务和缺陷。
- 最近 7 天由当前用户完成的需求、任务和缺陷。
- 自动发现当前 TAPD 企业中用户有权访问的项目。
- 自动发现失败时，通过一个 TAPD 项目链接或项目 ID 完成初始化。
- 一次只连接一个 TAPD 企业，可重新登录切换。
- “待处理 / 进行中 / 待验收 / 已完成”四列聚合看板。
- 按企业、项目和工作项类型保存 TAPD 原始状态映射。
- 拖动后立即回写 TAPD；失败时回退原列并显示原因。
- 打开时加载、每 60 秒自动刷新、手动刷新；组件不可见时暂停轮询。
- TAPD 登录、连接状态、Token 失效与重新登录流程。
- GitLab 连接状态占位，不实现 GitLab 登录或数据读取。
- React + shadcn 风格的 Codex 全屏插件 UI。
- 使用固定在 Codex 左侧栏的专用任务作为看板稳定入口。
- 与 UI 等价的无界面 MCP 工具。

### 3.2 第一版不包含

- 多 TAPD 企业同时聚合。
- TAPD Webhook 实时推送。
- GitLab 登录、代码仓库、分支、提交或流水线数据。
- 飞书通知、拉群或讨论流程。
- 创建和编辑工作项正文。
- 公网多用户协作看板。
- CDP 注入或 Codex 客户端私有接口修改。

## 4. 分阶段交付

### 4.1 Phase 0：Codex 插件页面 Demo

Phase 0 先证明插件注册、MCP Apps UI 渲染和 bridge 调用链路，不接入 TAPD。

必须实现：

- FlowRivet 私有插件可安装、启用和识别。
- 本地 MCP Server 可由插件启动或连接。
- `open_my_taskboard` 工具返回看板 UI Resource。
- Codex 中可打开全屏 React 看板。
- 打开看板时自动请求全屏；宿主拒绝或不支持时保留手动全屏按钮。
- 使用固定模拟数据展示左侧项目导航、四列卡片、连接菜单和未登录状态。
- 使用成熟拖拽库完成前端模拟拖动，但不调用 TAPD。
- UI 通过 MCP Apps bridge 调用一个演示工具，并显示返回结果。
- Windows Codex 完成真实安装、打开、渲染和交互验收。

Phase 0 明确不实现 OAuth、TAPD API、SQLite、系统凭据库和真实状态回写。Phase 0 通过后才能开始 Phase 1。

### 4.2 Phase 1：真实 TAPD 待办闭环

Phase 1 在已验证的 UI 和插件链路上增加：

- TAPD 个人 Token 登录、连接状态和断开连接。
- Windows DPAPI 安全存储，以及 Linux/macOS 凭据适配接口。
- 项目发现与项目链接兜底。
- 需求、任务、缺陷读取和归一化。
- SQLite 缓存、状态映射和同步元数据。
- 60 秒刷新和手动刷新。
- 拖动回写、失败回退和权限错误。
- 真实测试企业 E2E。

## 5. 架构

第一阶段采用“官方插件 UI + 本地 Companion + TAPD 个人 Token”的本地架构。远程 OAuth Broker 保留为后续团队分发时的可选登录方式，不参与个人 Token 登录闭环。

```text
Codex Plugin UI (React + shadcn)
        │ MCP Apps bridge
        ▼
本地 FlowRivet Companion
        ├─ MCP tools 与 UI Resource
        ├─ TAPD 聚合与状态映射
        ├─ SQLite 缓存
        ├─ Windows DPAPI 加密的 TAPD Token
        ├─ 直接访问 TAPD 工作项 API
        └─ 未来访问内网 GitLab
                 ▲
                 │ 看板内一次性提交
用户 TAPD 个人 Token
```

### 5.1 选择理由

- 个人 POC 不需要 TAPD OAuth 应用的 `client_id` 或 `client_secret`，也不需要部署远程服务。
- Token 使用当前 Windows 用户的 DPAPI 密钥加密，仓库、SQLite、日志和 UI 结果中均不保存明文。
- 本地 Companion 能访问未来的内网 GitLab。
- 官方 MCP Apps UI 避免 Codex DOM 注入和 CSP 绕过。
- 工具与 UI 解耦，Codex 可在不打开看板时完成同等操作。

## 6. 组件边界

### 6.1 Codex 私有插件

- 打包 Skill、MCP 配置、UI 静态资源和插件清单。
- Skill 告诉 Codex 何时查询待办、打开看板和推进状态。
- 插件不包含 TAPD Token 或 TAPD 应用 Secret。

### 6.2 Codex 固定任务入口

- 创建名为“FlowRivet 待办看板”的专用 Codex 任务，并由用户固定到左侧栏。
- 任务以“打开我的 TAPD 待办看板”为稳定启动提示，通过 Skill 调用 `open_my_taskboard`。
- 固定任务只是 Codex 原生任务入口，不冒充插件自定义侧边栏菜单；插件不依赖 Codex 私有导航接口。
- 重新进入任务时允许再次调用渲染工具，不假设 iframe 或前端内存状态跨会话永久保留。

### 6.3 本地 Companion

- 提供 streamable HTTP MCP 服务。
- 注册数据工具、写工具和 `open_my_taskboard` 渲染工具。
- 托管 MCP Apps UI Resource。
- 管理 TAPD 同步、缓存、状态映射和登录状态。
- 通过 `CredentialStore` 读取 DPAPI 密文，不向 UI 返回 Token。

### 6.4 本地凭据存储

- 定义跨平台 `CredentialStore` 接口，首版实现 Windows DPAPI 适配器。
- 密文和非敏感元数据保存到 `%LOCALAPPDATA%\FlowRivet`；密文只能由当前 Windows 用户解密。
- DPAPI 或文件写入失败时登录失败，禁止降级为明文文件。
- Linux Secret Service 和 macOS Keychain 只保留适配边界，本轮返回 `unsupported_platform`。
- `TAPD_TOKEN` 仅作为开发兼容入口，UI 和 MCP 响应不回显其值。

### 6.5 可选远程 OAuth Broker

- 不参与 Phase 1A 个人 Token 登录，保留现有实现供未来团队分发使用。
- 创建五分钟授权事务。
- 使用服务端 TAPD 应用 Secret 交换授权码。
- 校验 TAPD 用户和企业资源。
- 通过 PKCE 证明向本地 Companion 一次性交付 Token。
- 不代理日常 TAPD 工作项 API。

### 6.6 TAPD 适配器

- 获取当前用户。
- 自动发现参与项目。
- 按项目读取当前用户负责的需求、任务和缺陷。
- 读取可用状态和工作流流转。
- 更新工作项状态。
- 将 TAPD 错误映射为稳定的领域错误。

## 7. MCP 工具设计

第一版至少提供：

| 工具 | 类型 | 作用 |
|---|---|---|
| `get_connection_status` | 读取 | 返回 TAPD、GitLab 连接状态，不返回凭据 |
| `login_with_tapd_token` | 操作 | 验证一次性提交的个人 Token，成功后用 DPAPI 加密保存 |
| `disconnect_tapd` | 操作 | 删除本机 TAPD 凭据和连接元数据 |
| `discover_tapd_projects` | 读取 | 自动发现项目并返回失败原因 |
| `add_tapd_project` | 操作 | 从项目链接或 ID 添加兜底项目 |
| `list_my_work_items` | 读取 | 返回归一化工作项、项目、同步状态和筛选元数据 |
| `get_status_mapping_options` | 读取 | 返回某项目和类型的 TAPD 原始状态 |
| `save_status_mapping` | 操作 | 保存四阶段到 TAPD 状态的映射 |
| `move_work_item` | 操作 | 校验映射和权限后回写 TAPD 状态 |
| `refresh_my_work_items` | 操作 | 触发一次同步并返回摘要 |
| `open_my_taskboard` | 渲染 | 返回最终结构化数据和看板 UI Resource |
| `demo_ping` | Phase 0 | 验证 UI 到 MCP 的 bridge 调用 |

数据工具和渲染工具分离。除 `open_my_taskboard` 外，工具必须在不渲染 UI 时仍然有完整、稳定的结构化返回。

## 8. 领域模型

统一工作项：

```ts
type CanonicalStage = "todo" | "in_progress" | "in_review" | "done";
type WorkItemKind = "story" | "task" | "bug";

interface WorkItem {
  key: string;              // 企业、项目、类型、TAPD ID 的稳定组合键
  tapdId: string;
  workspaceId: string;
  workspaceName: string;
  kind: WorkItemKind;
  title: string;
  stage: CanonicalStage;
  tapdStatus: string;
  priority?: string;
  dueAt?: string;
  completedAt?: string;
  updatedAt?: string;
  tapdUrl: string;
}
```

状态映射键为 `companyId + workspaceId + kind + canonicalStage`。映射值保存 TAPD 状态 ID、显示名和最后验证时间。

SQLite 只保存项目元数据、状态映射、工作项缓存、最后同步时间和连接的非敏感标识。Token 不进入 SQLite。

## 9. 登录与连接体验

### 9.1 未登录

- 看板不显示误导性的空列。
- 显示 TAPD Token 密码输入框和“连接 TAPD”按钮。
- Token 只在本次工具调用中提交；UI 不持久化、不回显，也不写入 URL。
- 说明登录后会自动发现项目；无法发现时可粘贴项目链接。

### 9.2 登录中

- UI 禁用输入和提交按钮，并调用 `login_with_tapd_token`。
- Companion 使用 Token 调用 TAPD 当前用户接口，验证用户、企业和权限。
- 验证成功后使用 Windows DPAPI 加密并原子写入本地凭据文件。
- MCP 只返回用户、企业和连接状态；UI 随即清空密码输入框。
- Phase 1A 登录成功后仍展示明确标记的 Demo 工作项；真实项目发现和同步由后续子任务实现。

### 9.3 已登录

- 顶部显示 TAPD 已连接和最后同步时间。
- 连接菜单显示企业和用户显示名。
- GitLab 显示“未连接，后续接入”，不提供不可用按钮。

### 9.4 Token 失效

- 保留最后缓存并标记“数据可能过期”。
- 禁止拖动和写操作。
- 提供重新登录；成功后恢复同步。

### 9.5 恢复与断开

- 重新打开看板时，Companion 读取并解密本机凭据，再调用 TAPD 验证有效性。
- TAPD 暂时不可用时返回 `tapd_unavailable`，不删除或覆盖已有凭据。
- Token 明确无效时连接状态切换为 `expired`，允许重新输入或断开。
- `disconnect_tapd` 删除密文与连接元数据，完成后无法从本机恢复 Token。

## 10. 项目发现

1. 优先调用 TAPD 当前用户参与项目能力。
2. 对发现结果执行权限范围内的工作项查询，不假设管理员权限。
3. 若 OAuth scope、API 或官方 MCP 能力无法枚举项目，返回结构化 `project_discovery_unavailable`。
4. UI 要求用户粘贴一个 TAPD 项目 URL 或项目 ID。
5. Companion 解析并验证项目；后续保留手动添加更多项目的入口。

非管理员只能读取和修改 TAPD 已授权范围内的工作项。管理员没有额外的隐式 FlowRivet 权限；所有能力以 TAPD 返回为准。

## 11. 同步与过滤

- 打开看板立即读取缓存并触发后台刷新。
- 以有限并发按项目、类型查询，单项目失败不阻断其他项目。
- 未完成工作项全部保留。
- 已完成工作项仅保留 `completedAt >= 当前时间 - 7 天`；缺少完成时间时使用可信状态变更时间，仍缺失则不进入已完成列。
- 60 秒轮询只在组件可见且 TAPD 已连接时运行。
- 手动刷新绕过轮询等待，但同一时刻只允许一个同步任务。
- 每次同步返回成功项目数、失败项目数、工作项数量和最后同步时间。

## 12. 状态归一化与回写

### 12.1 自动匹配

Companion 使用明确的状态 ID/名称候选匹配四阶段。匹配必须保守；存在多个候选时不得自行选择。

### 12.2 歧义处理

- 用户首次拖动到缺少映射的阶段时，UI 请求该项目和类型的合法状态。
- 用户选择后保存映射，并继续本次移动。
- 映射按项目和工作项类型隔离。

### 12.3 拖动回写

1. UI 将卡片乐观移动到目标列并显示“同步中”。
2. 调用 `move_work_item`，传稳定 key、目标阶段和客户端已知 `updatedAt`。
3. Companion 验证登录、映射、工作项最新版本和 TAPD 合法流转。
4. 成功后返回 TAPD 最新工作项。
5. 失败时 UI 回退原列并显示可读原因。

写操作不自动后台重试，防止网络恢复后产生过期状态变更。

## 13. UI 设计

- 全屏 MCP Apps UI，shadcn 风格，紧凑、低装饰、适合反复扫描。
- UI 初始化完成后请求 `fullscreen` 展示模式；失败时保持内嵌可用并显示全屏按钮。
- 全屏按钮只在宿主声明支持全屏时启用；请求失败要给出非阻塞提示，不影响看板读取和操作。
- 顶部：FlowRivet、TAPD 连接状态、最后同步、刷新、账号菜单。
- 左侧：全部待办、即将到期、已逾期、自动发现项目及数量。
- 主区：待处理、进行中、待验收、已完成四列。
- 卡片：TAPD ID、标题、类型、优先级、到期时间；项目上下文由当前筛选和必要标签表达。
- 点击卡片打开右侧详情抽屉，提供 TAPD 原链接。
- 拖动使用稳定尺寸和占位，避免列宽和卡片跳动。
- 未登录、加载、部分失败、全失败、空数据、Token 失效、同步中均有独立状态。
- 不使用嵌套卡片、营销式大标题或装饰性渐变。

## 14. 错误处理

| 场景 | 行为 |
|---|---|
| Token 失效 | 展示缓存、禁止写入、引导重新登录 |
| Token 无效 | 返回 `invalid_token`，不创建或覆盖本机凭据 |
| 权限不足 | 返回 `permission_denied`，不保存 Token |
| TAPD 暂时不可用 | 返回 `tapd_unavailable`，保留已有凭据并允许重试 |
| DPAPI 或文件写入失败 | 返回 `credential_store_failed`，禁止明文降级 |
| 非 Windows 平台 | 返回 `unsupported_platform`，等待对应安全存储适配器 |
| 单项目读取失败 | 其他项目继续展示，侧栏标记并允许重试 |
| 无权限流转 | 卡片回退，显示当前账号无权执行 |
| 非法工作流流转 | 卡片回退，显示 TAPD 合法目标状态 |
| 并发修改 | 刷新该卡片，以 TAPD 最新状态为准 |
| 状态映射缺失 | 弹出原始状态选择，不猜测写入 |
| 网络中断 | 展示缓存；恢复后重试读取，不重试写入 |
| 项目自动发现不可用 | 显示项目链接/ID 兜底入口 |

所有日志携带 `requestId`、工具名、项目 ID 和工作项 ID。禁止记录 Token、Authorization、授权码、state、verifier、应用 Secret 或工作项正文。

## 15. 测试策略

### 15.1 Phase 0

- 插件 manifest 与包结构校验。
- MCP initialize、tools/list、resources/read 和 `open_my_taskboard` 合约测试。
- React 生产构建和 CSP/iframe 资源加载测试。
- MCP Apps bridge 演示调用测试。
- 自动全屏请求、手动全屏兜底和宿主不支持全屏的降级测试。
- 看板四列、项目导航、登录菜单、未登录状态和模拟拖动组件测试。
- Playwright 在 Codex 支持的桌面/窄窗口尺寸执行截图、溢出和交互验证。
- Windows Codex 真实安装、启用、打开和非空像素截图验收。

### 15.2 Phase 1 单元与合约

- TAPD 三类工作项的解析和归一化。
- 最近 7 天完成过滤边界。
- 自动项目发现和项目 URL 解析。
- 状态自动匹配、歧义和映射隔离。
- `CredentialStore` 接口与 Windows DPAPI 适配器，禁止 SQLite 和日志持久化明文 Token。
- 登录成功、无效 Token、权限不足、TAPD 不可用、存储失败、恢复、过期和断开状态机。
- 凭据文件只包含密文和非敏感元数据；日志和 MCP 响应不包含 Token 或 Authorization。
- 并发冲突、权限错误和网络错误分类。
- 所有 MCP 工具输入输出 Schema。

### 15.3 Phase 1 E2E

1. 在看板内提交个人 Token，验证成功后自动返回已连接看板。
2. 自动发现多个项目并聚合当前用户的需求、任务和缺陷。
3. 自动发现失败后通过项目链接加载。
4. 四阶段映射与首次歧义选择。
5. 拖动成功回写 TAPD。
6. 无权限、非法流转和网络失败时卡片回退。
7. Token 失效后重新登录。
8. 最近 7 天已完成过滤。
9. UI 与无界面 MCP 工具结果一致。
10. Windows、Linux、macOS 配置路径和凭据存储契约。
11. 重启 Companion 后恢复连接，断开后凭据不可恢复。

## 16. 准入与准出标准

### 16.1 Phase 0 准入

- Codex 插件、MCP Apps UI 和插件目录的当前官方能力已确认。
- FlowRivet 插件包保留独立的 MCP、UI 和 Skill 边界。
- 不需要 TAPD 凭据即可运行 Demo。

### 16.2 Phase 0 准出

- 私有插件在 Windows Codex 中成功注册和启用。
- `open_my_taskboard` 在 Codex 中渲染非空全屏页面。
- “FlowRivet 待办看板”专用任务可固定到左侧栏，并能重复打开看板。
- 自动全屏成功，或在宿主拒绝时可通过按钮重试且内嵌看板保持可用。
- 模拟看板、登录状态和拖动可交互。
- UI 到 MCP 的演示调用成功。
- 测试、类型检查、生产构建和 Playwright 视觉验证通过。

### 16.3 Phase 1A 个人 Token 登录准入

- Phase 0 已通过，不再变更插件 UI 承载方式。
- Windows 测试用户可使用 DPAPI，`%LOCALAPPDATA%` 可写。
- 测试账号提供可调用当前用户接口的 TAPD 个人 Token。
- 没有真实测试 Token 时只完成自动化合约测试，不宣称真实 E2E 通过。

### 16.4 Phase 1A 个人 Token 登录准出

- 看板内可提交 Token，成功后只显示用户、企业和连接状态。
- Token 不出现在仓库、SQLite、日志、MCP 响应、URL 或浏览器持久化中。
- 重启 Companion 后可以从 DPAPI 密文恢复连接。
- 无效 Token 不创建凭据；存储失败不降级为明文。
- 断开连接后凭据文件被删除且 Token 无法恢复。
- Windows 真实 Token E2E 通过；Linux/macOS 返回稳定的 `unsupported_platform`。

### 16.5 Phase 1 完整准出

- 真实测试企业完成登录、项目加载、三类型读取和拖动回写闭环。
- 自动刷新连续运行且不会产生重复同步。
- 权限不足和失败写入不会造成 UI/TAPD 状态漂移。
- Token 不出现在 SQLite、日志、UI 结果或仓库。
- 全量测试、类型检查、生产构建和 E2E 通过。
- Windows 可用；Linux 和 macOS 的路径与凭据后端至少通过契约测试。

## 17. 未决技术验证

以下内容不改变产品设计，但必须在 Phase 1 开始前通过探针确定：

- 用户 OAuth 下自动发现项目的实际 TAPD API 或官方 MCP 工具。
- `task`、`bug` 所需 OAuth scope 的准确名称和开放平台授权结果。
- 三种工作项状态更新 API 的参数和工作流限制。
- TAPD 是否提供可靠的完成时间和并发版本字段。
- Linux Secret Service 在无桌面会话时的降级策略。
