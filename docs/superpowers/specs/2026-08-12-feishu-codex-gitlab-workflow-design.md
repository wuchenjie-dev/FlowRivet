# FlowRivet 飞书任务到 Codex 与 GitLab 研发闭环设计

## 1. 背景

FlowRivet 已能通过官方 Meegle CLI 登录飞书项目、读取当前账号的个人工作项，并在 Codex 中展示只读看板。下一阶段需要让用户从待办工作项直接启动 Codex，由 Codex 完成需求拆解、需求分析或代码开发，并把结构化结果回写飞书项目。

代码开发必须接入企业自建 GitLab。运行时只使用本机 `git` 和 GitLab 官方 `glab` CLI，不实现或直接调用 GitLab REST/GraphQL 客户端，也不建立 FlowRivet 自有的 GitLab Token 存储。`glab` 内部仍通过 GitLab 官方接口完成操作；FlowRivet 只消费 CLI 合同。目标 GitLab 实例为 `https://gitlab-aiabu.ruijie.com.cn/`。

本设计扩展 `2026-08-11-feishu-project-meegle-provider-design.md` 的只读阶段。现有飞书任务读取、缓存、通知和自动更新能力继续作为前置能力，不在本设计中重做。

## 2. 目标

- 在工作项详情中提供统一的“开始处理”入口。
- 一条飞书工作项稳定关联一个 Codex 任务；再次进入时恢复同一任务。
- 用户在每次执行开始前明确选择“仅处理当前事项”或“需要修改代码”，不由 Codex 根据标题强制猜测执行分类。
- 流程梳理、需求分析、需求拆解和文档输出等非代码事项不要求代码仓库。
- 仅当用户明确选择需要修改代码时，才让用户从其有权限的 GitLab 仓库中选择；不维护固定的飞书项目到仓库映射。
- 优先复用当前 Codex 工作区或已有本地仓库；没有匹配仓库时由用户选择父目录并自动克隆。
- 允许 Codex 自动创建功能分支、修改和测试代码、推送分支并创建 Merge Request。
- 合并 MR、重试 Pipeline 和关闭飞书工作项必须获得用户逐次确认。
- 把分析摘要、拆解项、测试结果、分支、MR 和 Pipeline 状态结构化回写飞书项目，不覆盖原始需求正文。
- Windows、Linux 和 macOS 使用同一合同，平台差异限制在命令发现、进程控制和目录选择适配器中。

## 3. 非目标

- FlowRivet 不直接调用 GitLab REST、GraphQL 或其他 GitLab API；GitLab 网络访问统一经 `glab`。
- 不提供 GitLab API 降级路径。
- 不在 FlowRivet 中保存、刷新或分发 GitLab OAuth Token。
- 不使用 GitLab 管理员、`sudo`、`admin_mode`、服务账号或 impersonation 权限。
- 不自动合并 MR、直接推送受保护分支、自动重试 Pipeline 或自动关闭飞书工作项。
- 不自动推断任务所属仓库，也不维护飞书项目与 GitLab 仓库的默认映射。
- 不以 GitLab Deploy Token 或自动更新凭据代表当前用户；发布凭据与研发身份严格隔离。
- 不在首版聚合多个 Codex 任务处理同一飞书工作项。
- 不替代 Codex 的代码编辑、测试和任务执行能力。

## 4. 用户决策

| 决策 | 结果 |
| --- | --- |
| 任务入口 | 统一“开始处理”，用户先选择本次是否需要修改代码 |
| Codex 任务模型 | 一条飞书工作项对应一个稳定 Codex 任务 |
| 执行模式 | 每个执行轮次独立选择 `non_code` 或 `code`，不永久记忆 |
| GitLab 登录 | `glab` 浏览器 OAuth 登录 |
| GitLab 集成 | 只使用 `git + glab`，不接 GitLab API |
| 仓库选择 | 首次进入代码开发时由用户选择；创建研发分支前可修改，创建后锁定 |
| 本地仓库 | 优先复用，未匹配时选择父目录并克隆 |
| 自动写操作 | 创建功能分支、推送代码、创建 MR |
| 人工门禁 | 合并 MR、重试 Pipeline、关闭飞书任务 |
| 飞书回写 | 结构化回写和产物链接，不覆盖原始正文 |

## 5. 总体架构

```text
Codex 看板 / FlowRivet App
          |
          v
Work Execution Service
  |       |        |
  |       |        +--> Result Writer --> Meegle CLI --> 飞书项目
  |       |
  |       +--> GitLab Adapter
  |              |--> git CLI
  |              +--> glab CLI
  |
  +--> Codex Task Bridge --> Codex 任务与本地工作区
          |
          v
Execution Link Store (非敏感关联数据)
```

### 5.1 Work Execution Service

负责工作项执行状态机、幂等、权限门禁和组件编排。它只依赖稳定接口，不直接拼装 CLI 命令，也不持有 OAuth Token。

```ts
interface WorkExecutionService {
  prepare(input: { providerId: string; workItemKey: string }): Promise<ExecutionPreparation>;
  bindRepository(input: { executionId: string; gitlabProject: GitLabProjectRef }): Promise<ExecutionRecord>;
  recordArtifact(input: ExecutionArtifactInput): Promise<ExecutionRecord>;
  requestGuardedAction(input: GuardedActionInput): Promise<ConfirmationChallenge>;
  confirmGuardedAction(input: ConfirmedActionInput): Promise<ExecutionRecord>;
}
```

### 5.2 Codex Task Bridge

负责按飞书工作项创建或恢复 Codex 任务，并把最小、可验证的执行上下文交给 Codex。它不把工作项正文当作系统指令；外部文本始终标记为不可信业务内容，防止需求描述或评论中的提示注入绕过确认门禁。

Codex 任务创建能力取决于宿主提供的任务 API。实现前必须通过合同探针验证创建、恢复、传入上下文和返回任务标识的能力。若宿主不能由 App 直接创建任务，首版改为生成结构化 handoff，由用户点击后在当前 Codex 中创建任务；不得伪造已创建状态。

### 5.3 GitLab Adapter

GitLab Adapter 对业务层暴露类型化接口，内部只调用 `git` 和 `glab`：

```ts
interface GitLabAdapter {
  getCapabilities(): Promise<GitLabCapabilities>;
  getConnection(): Promise<GitLabConnection>;
  startLogin(): Promise<GitLabLoginAttempt>;
  listProjects(input?: { search?: string; page?: number }): Promise<GitLabProjectPage>;
  inspectWorkspace(path: string): Promise<WorkspaceInspection>;
  cloneProject(input: CloneProjectInput): Promise<WorkspaceInspection>;
  createBranch(input: CreateBranchInput): Promise<BranchResult>;
  pushBranch(input: PushBranchInput): Promise<PushResult>;
  createMergeRequest(input: CreateMergeRequestInput): Promise<MergeRequestRef>;
  getPipeline(input: PipelineQuery): Promise<PipelineSummary>;
  retryPipeline(input: ConfirmedPipelineRetry): Promise<PipelineSummary>;
  mergeMergeRequest(input: ConfirmedMergeRequestMerge): Promise<MergeRequestRef>;
}
```

业务层不得看到命令行、环境变量或 `glab` 配置文件结构。CLI 行为变化只影响 Adapter 和合同测试。

### 5.4 Result Writer

Result Writer 通过官方 Meegle CLI 的已验证写命令回写飞书项目。实施前必须探针确认评论、子工作项、字段更新和节点流转的公开命令、权限与 JSON 合同。未通过探针的写能力不得用网页自动化或未公开接口替代。

## 6. 身份、权限与凭据

### 6.1 飞书项目

普通用户以当前 Meegle CLI OAuth 身份执行操作。所需能力按操作最小化：

- 读取工作项、详情和关联资料。
- 在用户本身有权限的工作项中创建评论或结构化产物记录。
- 在流程允许时创建子工作项或更新节点。
- 关闭工作项仅在用户确认后执行，且仍受飞书项目自身权限和工作流约束。

FlowRivet 不提升飞书项目权限。权限不足时返回明确的拒绝结果并保留本地执行记录。

### 6.2 GitLab

用户通过 `glab auth login --hostname gitlab-aiabu.ruijie.com.cn --web --git-protocol https --use-keyring` 登录。自建 GitLab 必须注册供 `glab` 使用的公共 OAuth Application，并取消 `Confidential`；FlowRivet 只配置公开的 Application ID，不需要或保存 Client Secret。

已验证的 `glab 1.113.0` 自建实例 OAuth 合同需要 `openid`、`profile`、`read_user`、`api` 与 `write_repository`。最终可执行操作仍由用户在具体项目中的角色、分支保护、审批规则和 Pipeline 权限限制。推荐普通研发用户为 Developer；FlowRivet 不要求管理员权限。

`glab --use-keyring` 管理凭据。FlowRivet 不读取钥匙串 Token、不把 Token 写入环境变量、命令参数、Git remote URL、日志、MCP 结果或 React 状态。自动更新使用的 Deploy Token 与当前 GitLab 用户身份完全隔离。

## 7. CLI 发现与执行边界

Companion 启动和打开 GitLab 功能时检查：

1. `git` 是否存在且版本满足已验证下限。
2. `glab` 是否存在且版本满足已验证下限。
3. `glab auth status --hostname <host>` 是否显示当前实例已登录。
4. 当前工作区的 remote 是否与所选项目匹配。

缺少 `git` 或 `glab` 时展示平台对应的安装指引和“重新检查”，不静默安装。未登录时启动 `glab` 的浏览器 OAuth 流程。FlowRivet 不通过直接 API 请求判断登录状态。

所有 CLI 执行必须：

- 使用固定可执行文件与参数数组，不通过 Shell 拼接用户输入。
- 仓库路径、分支名、标题和描述作为独立参数或标准输入传递。
- 优先使用官方 JSON 输出；命令没有稳定 JSON 输出时，必须先增加版本锁定和专用严格解析合同，不能解析面向人的表格布局。
- 设置超时、标准输出/错误输出上限，并在超限时终止完整进程树。
- 记录 `requestId`、操作类型、耗时、退出码和脱敏错误码，不记录正文、Token、仓库凭据或完整命令参数。
- 对 Windows `.exe`/`.cmd`、Linux 和 macOS 原生可执行文件分别做合同测试。

不提供 GitLab API 降级。`glab` 缺失、版本不兼容、未登录或输出合同变化时，相关功能进入明确的阻塞状态；已取得的飞书看板仍可使用。

## 8. 数据模型与幂等

本地只保存非敏感关联：

```ts
interface ExecutionRecord {
  schemaVersion: 2;
  executionId: string;
  providerId: "feishu-project";
  accountKey: string;
  workItemKey: string;
  attempt: number;
  workItemUpdatedAt?: string;
  taskLaunchMode: "direct" | "handoff";
  codexTaskId?: string;
  codexHandoffId?: string;
  handoffDispatchedAt?: string;
  workMode: "pending" | "non_code" | "code";
  executionKind?: "requirement_breakdown" | "requirement_analysis" | "development";
  state: "prepared" | "awaiting_repository" | "ready" | "running" |
    "awaiting_confirmation" | "writeback_pending" | "completed" | "failed";
  gitlab?: {
    host: string;
    projectId: string;
    projectPath: string;
    localPath: string;
    branch?: string;
    mergeRequestIid?: number;
    mergeRequestUrl?: string;
    pipelineId?: string;
  };
  artifacts: ExecutionArtifact[];
  createdAt: string;
  updatedAt: string;
}
```

`workMode` 是仓库门禁的唯一依据。`executionKind` 只作为可选的描述性标签，用于结果模板和统计，不参与状态流转，也不阻止用户纠正判断。

执行轮次唯一键为 `providerId + accountKey + workItemKey + attempt`，`attempt` 从 1 单调递增。首次“开始处理”创建记录和 Codex 任务，重复点击恢复最新未终止执行。终态执行保留为历史；用户显式重新处理同一工作项时创建下一轮，`workMode` 重置为 `pending`。新轮次可以继承上一轮的 `codexTaskId`，但使用新的 `executionId`、handoff 和产物集合，防止不同轮次的确认、仓库或结果串线。用户切换飞书账号后不能看到或恢复其他账号的执行关联。

SQLite schema version 2 移除旧的三字段唯一约束，增加非空 `attempt` 列和四字段唯一索引；迁移时每个旧记录写入 `attempt=1`，必须在单个事务中复制、校验行数并替换表。`findCurrent` 按 `attempt DESC` 读取最新未终止记录，`findLatest` 可读取包含终态的最新轮次；并发创建下一轮依赖四字段唯一约束冲突后重新读取，不用先读后写猜测轮次。

Payload 读取器兼容 Schema version 1：`pending_classification + prepared` 推导为 `workMode=pending`；`executionKind=development` 推导为 `code`；其他记录推导为 `non_code`。兼容读取不立即批量改 payload；记录下次保存时升级为 version 2。数据库迁移与 payload 惰性升级是两个独立版本边界，不得把任一失败静默当作空执行。

仓库只在当前执行首次选择 `workMode=code` 时选择。选择结果保存到该 `ExecutionRecord`，再次恢复同一执行不重复询问；用户可显式执行“更换仓库”，该操作必须先检查未推送提交和活动 MR，避免把同一执行错误关联到两个仓库。

每个有副作用的操作使用唯一 `operationId`。进程重启或用户重试时先检查本地记录和远端可观察结果，避免重复创建分支、MR、子任务或评论。

## 9. 用户流程

### 9.1 统一开始处理

1. 用户在看板打开工作项详情并点击“开始处理”。
2. FlowRivet 创建或恢复 `workMode=pending + state=prepared` 的 `ExecutionRecord`，在详情抽屉展示“仅处理当前事项”和“需要修改代码”。此时不向 Codex 发送 handoff。
3. 用户选择“仅处理当前事项”后记录变为 `workMode=non_code + state=ready`，FlowRivet 创建或恢复 Codex 任务并发送 handoff；流程梳理、分析、拆解和文档均走此路径。
4. 用户选择“需要修改代码”后记录变为 `workMode=code + state=awaiting_repository`，先完成仓库选择；关联成功后变为 `state=ready` 并发送 handoff。
5. Codex 读取用户已经确认的 `workMode`、工作项详情、关联资料和已有执行产物，展示目标、计划、拟使用权限和预期产物，不再调用工具猜测三分类。
6. 用户确认计划后开始执行。

`prepared`、`awaiting_repository`，以及 `handoffDispatchedAt` 为空的 `ready` 状态允许双向修改 `workMode`。从 `code` 改为 `non_code` 时关闭仓库对话框并撤销仓库要求；尚未产生 Git 活动的临时仓库关联可以移除。从 `non_code` 改为 `code` 时进入仓库选择。`App.sendMessage()` 成功后，UI 立即调用 `mark_execution_handoff_dispatched(executionId, handoffId)` 写入 `handoffDispatchedAt`；从此即使 Codex 尚未回报 `running`，执行模式也锁定。创建分支、产生 MR 或产物，或进入 `running`、`awaiting_confirmation`、`writeback_pending`、`completed` 后同样锁定并返回 `execution_mode_locked`。消息发送失败不调用确认工具，用户可重试或修改模式。

宿主消息发送与本地确认不是原子事务，因此不承诺 exactly-once。两步之间崩溃时，恢复页展示“交接状态待确认”，使用稳定 `handoffId` 重新发送一条明确的恢复消息，再幂等调用确认工具；Codex 侧按 `handoffId` 识别同一交接，不创建新的执行或扩大权限。日志记录发送尝试和确认结果，但不记录 prompt 正文。

需求文本、评论、附件和代码均视为不可信输入。它们不能改变系统门禁、申请额外凭据、自动确认破坏性操作或扩大允许目录。

### 9.2 需求拆解与需求分析

需求拆解产物至少包括：范围、子任务、依赖、准入、准出、验收标准、风险和待确认问题。需求分析产物至少包括：目标、现状、方案比较、推荐方案、影响范围、验收方式和未决问题。

完成后 Result Writer 写入简短摘要和结构化条目；长内容放入飞书文档或仓库文档，并只回写链接。未配置可写目标时保留本地产物并提示用户，不把本地完成误报为已回写。

### 9.3 代码开发

1. 检查 GitLab CLI 能力与登录状态。
2. 分页展示当前用户可访问的项目，支持搜索；用户明确选择一个仓库。
3. 检查 Codex 当前工作区和已知本地仓库的 remote。精确匹配所选 GitLab 项目时复用。
4. 没有匹配时让用户选择本地父目录；目标目录必须位于用户选定范围、为空或不存在，然后执行克隆。
5. 检查工作树状态、默认分支和保护规则可观察信息。存在用户未提交修改时不得覆盖、清理或混入新分支；引导用户选择其他 worktree 或先处理修改。
6. 从最新基线创建 `codex/<work-item-id>-<slug>` 功能分支。分支冲突时复用已关联分支或生成稳定后缀，不覆盖他人分支。
7. Codex 按批准的计划编辑代码、运行测试并提交。
8. 自动推送功能分支并创建 MR。MR 描述包含飞书工作项链接、变更摘要、测试结果和 FlowRivet 执行标识，但不包含敏感上下文。
9. 读取 Pipeline 状态并结构化回写飞书项目。

FlowRivet 只编排 GitLab 操作；代码编辑、构建和测试由 Codex 在明确工作区内完成。提交作者使用用户本地 Git 配置，不由 FlowRivet伪造。

### 9.4 本机目录选择

仓库对话框的路径输入框右侧提供“选择文件夹”按钮。选择行为随准备方式变化：

- “复用本地仓库”选择具体的已有 Git 仓库目录。
- “克隆到父目录”选择用于创建目标仓库目录的父目录。

MCP App 不使用浏览器 `showDirectoryPicker`，因为浏览器目录句柄不能可靠提供本机绝对路径，也不能满足后续 `git`/`glab` 子进程合同。页面调用只读工具 `select_local_directory`，由本机 Companion 的 `DirectoryPicker` 接口打开系统原生目录选择窗口，并只返回用户本次明确选择的绝对路径。

```ts
interface DirectoryPicker {
  selectDirectory(input: {
    purpose: "existing_repository" | "clone_parent";
    initialDirectory?: string;
    signal: AbortSignal;
  }): Promise<{ outcome: "selected"; absolutePath: string } | { outcome: "cancelled" }>;
}
```

`select_local_directory` 接收可选 `initialDirectory`。页面再次打开选择器时传入当前输入框中的路径提示，使系统窗口尽量从用户已经选择的目录开始；输入为空时使用系统默认位置。Companion 只在该提示是当前平台上存在的绝对目录时应用它；相对路径、不存在路径或不可访问路径不阻断用户恢复，而是忽略提示并照常打开系统默认位置。路径通过固定参数或最小环境变量传给 Adapter，不拼进脚本文本，也不进入日志。

平台差异限制在 Adapter 内：Windows 使用支持 `SelectedPath` 的 STA 系统文件夹选择对话框，以当前 Codex 前台窗口为 owner，并保持 PowerShell 控制台隐藏；不得把 `Shell.Application.BrowseForFolder` 的 root 参数误作初始位置，因为该参数会限制用户向上浏览。macOS 使用 `osascript` 的 default location；Linux 按已验证顺序发现 `zenity` 或 `kdialog` 并使用各自的起始目录参数。每个 Adapter 使用固定可执行文件和固定参数数组，不拼接路径或 Shell 字符串。平台缺少可用选择器时返回稳定错误 `directory_picker_unavailable`，页面保留手动输入，不扫描磁盘或猜测目录。

目录选择是可取消的长请求。MCP 请求取消、App 关闭或 Companion 停止时，取消信号必须关闭选择器并终止完整子进程树；用户点击系统对话框“取消”映射为正常的 `cancelled`，不显示错误。同一 Companion 只允许一个活动选择会话，后续请求返回 `directory_picker_busy`，不得排队后突然弹窗。

选择器只负责取得路径，不负责信任路径。用户确认关联时继续通过现有 Repository Workflow 校验：路径必须为绝对路径；复用模式必须为 Git 仓库且 remote 匹配所选 GitLab 项目；克隆模式的父目录必须存在、可访问，目标目录必须满足克隆安全条件。

安全和隐私约束：

- 只有用户点击按钮后才能打开选择器，不允许后台或自动弹出。
- Companion 不遍历、索引或上传文件系统，不返回目录内容。
- 日志只记录 requestId、purpose、outcome、平台和耗时，不记录所选路径。
- 取消选择保持原输入值和当前仓库选择不变。
- 同一时刻只允许一个选择会话；重复点击在会话完成前禁用。
- 选择结果只进入当前 React 表单和现有仓库绑定调用，不新增全局最近目录持久化；再次打开时只使用当前表单值作为初始目录。

### 9.5 仓库关联修改与锁定

首次关联成功后，执行摘要继续展示 GitLab 项目与本地路径。只要当前执行尚未创建研发分支或 MR，摘要提供“修改仓库关联”命令；重新打开仓库对话框时按已绑定的 `projectId` 或 `projectPath` 精确查找并预选项目、回填 `localPath`。已关联项目不在首个分页结果时继续用精确条件查找并置顶展示；查找失败时保留只读的当前关联信息和明确错误，要求用户重新选择，不根据执行记录伪造缺少默认分支或 URL 的 GitLab 项目对象。用户可修改项目、本地仓库或克隆父目录，确认后仍通过 Repository Workflow 重新校验并覆盖旧关联。

创建研发分支或 MR 后，仓库关联成为执行追踪的一部分，不再允许更换。UI 将修改命令显示为不可用的“仓库关联已锁定”，并说明继续使用当前仓库才能保证提交、分支和 MR 可追踪；服务端允许完全相同的关联幂等重试，但项目 ID、项目路径或本地路径任一变化都以 `execution_repository_locked` 拒绝。Pipeline 或其他后续活动不放宽该边界。

仓库关联交互采用克制的工程控制台风格，与现有看板保持一致：

- 目录选择中按钮显示“等待系统选择...”和 loading 图标，禁用重复点击；选择完成后短暂显示“目录已选择”。
- 提交关联后按钮显示“正在关联...”，弹窗和输入保持稳定；失败时保留项目、路径和弹窗并显示可恢复错误。
- 关联成功后关闭弹窗，在执行摘要显示“仓库已关联”状态；修改成功使用同一反馈，不制造新的执行记录。
- 创建分支后使用低强调锁定按钮和原因说明，不用仅靠颜色表达状态。
- 状态反馈使用 `role="status"`，错误使用 `role="alert"`；动效为 160–220ms 的低干扰 CSS 过渡，并遵守 `prefers-reduced-motion`。

### 9.6 人工确认门禁

以下操作必须生成短期 `ConfirmationChallenge`，展示精确目标和影响，并要求用户逐次确认：

- 合并 MR：展示项目、MR、源分支、目标分支、审批和 Pipeline 状态。
- 重试 Pipeline：展示项目、Pipeline ID、提交和将重新运行的范围。
- 关闭飞书工作项：展示工作项、当前节点、拟进入节点和关联产物。

确认绑定 `operationId`、用户身份、目标资源当前版本和五分钟有效期。目标状态变化、超时、账号变化或 Companion 重启后确认失效，必须重新展示。自然语言中的“全部自动处理”不能作为这些操作的持久授权。

## 10. 结构化回写

回写不覆盖飞书工作项原始正文。首版优先使用评论和子工作项；只有管理员事先配置并通过探针验证的专用字段才可更新。

统一回写块包含：

```text
FlowRivet 执行摘要
- executionId / requestId
- 执行模式、可选描述标签与当前状态
- 分析或拆解摘要
- 子任务与验收标准链接
- GitLab 项目、分支、MR
- 测试命令与结论
- Pipeline 状态
- 最近更新时间
```

重复回写以 `executionId + artifactType + revision` 幂等更新或追加，不因重试产生无法识别的重复评论。飞书写入失败不撤销已成功的 Git 提交或 MR；记录 `writeback_pending` 并允许安全重试。

关闭工作项只有在用户确认且飞书工作流允许时执行。关闭失败时 MR 和执行记录保持原状，并给出权限或准出标准未满足的原因。

## 11. UI 与 Codex 工具

### 11.1 看板 UI

- 工作项详情新增主要命令“开始处理”。已有执行时显示“继续处理”。
- 点击开始后先显示两个互斥选项：“仅处理当前事项”和“需要修改代码”；选项仅对本次执行有效，确认前不发送 Codex handoff。
- 执行摘要显示 Codex 任务、执行模式、可选描述标签、仓库、分支、MR、Pipeline 和回写状态。
- 只有 `workMode=code` 时打开仓库选择对话框，不在连接菜单中维护全局仓库映射。
- 预执行阶段提供“修改执行方式”；切换为非代码模式后立即关闭仓库对话框并继续同一执行。
- 本地路径输入框提供文件夹图标按钮并配有可访问名称；选择中禁用重复操作，取消或失败不清空已有输入，再次选择从当前路径开始。
- 已关联仓库在分支创建前可重新打开并预选项目与路径；分支或 MR 创建后显示锁定原因且不能替换。
- 目录选择、仓库关联、关联成功和关联锁定均提供可见且可访问的状态反馈，按钮宽度与文案变化不造成布局跳动。
- 连接菜单新增 GitLab 状态：CLI 缺失、未登录、已连接、版本不兼容、暂不可用。
- 高风险操作使用明确的确认对话框，不使用普通按钮误触；确认按钮写明具体动作。

### 11.2 MCP/Codex 工具

工具按读取、普通写入和受门禁写入拆分：

- `prepare_work_item_execution`
- `get_work_item_execution`
- `set_work_item_execution_mode`
- `mark_execution_handoff_dispatched`
- `list_gitlab_projects`
- `select_local_directory`
- `bind_execution_repository`
- `inspect_execution_workspace`
- `record_execution_artifact`
- `push_execution_branch`
- `create_execution_merge_request`
- `get_execution_pipeline`
- `prepare_guarded_action`
- `confirm_guarded_action`
- `write_back_execution_result`

读取工具标记 `readOnlyHint`。创建分支、推送、创建 MR 和回写标记为非只读；合并、重试和关闭只允许通过确认工具执行。任何工具都不能接受任意可执行文件路径、任意 Shell 字符串或调用方提供的 Token。

`set_work_item_execution_mode` 只接受 `non_code | code`。相同模式请求幂等；handoff 发送前允许双向切换。`code` 且未绑定仓库时返回 `repository_required`；`non_code` 返回可发送给 Codex 的 ready 执行。handoff 已送达、Git 活动、产物或运行状态已经锁定时返回 `execution_mode_locked`。原 `classify_work_item_execution` 仅为旧插件兼容保留一个发布周期，不再出现在新 handoff 中，也不再作为仓库门禁来源。

`mark_execution_handoff_dispatched` 只接受当前执行已保存的 `codexHandoffId`，不同 ID 返回 `execution_handoff_conflict`；相同 ID 重试幂等。工具只在 `workMode` 已确定且执行为 `ready` 时写入时间，不接受调用方提供时间戳。

`select_local_directory` 仅接受稳定枚举 `existing_repository | clone_parent`，标记为只读且不接受起始路径。工具结果只包含 `selected + absolutePath` 或 `cancelled`；并发选择、平台不支持、选择器启动失败和返回非绝对路径分别映射为 `directory_picker_busy`、`directory_picker_unavailable`、`directory_picker_failed` 和 `directory_picker_invalid_result`。路径不得进入日志或错误文本。

## 12. 错误处理与恢复

稳定错误至少包括：

- `git_cli_missing`、`git_cli_unsupported`
- `gitlab_cli_missing`、`gitlab_cli_unsupported`
- `gitlab_not_connected`、`gitlab_unauthorized`
- `gitlab_project_forbidden`、`gitlab_output_invalid`
- `workspace_not_selected`、`workspace_dirty`、`workspace_mismatch`
- `directory_picker_busy`、`directory_picker_unavailable`、`directory_picker_failed`、`directory_picker_invalid_result`
- `branch_conflict`、`push_rejected`
- `merge_request_create_failed`、`pipeline_query_failed`
- `confirmation_required`、`confirmation_expired`、`confirmation_stale`
- `codex_task_create_failed`、`codex_task_unavailable`
- `execution_mode_locked`
- `execution_handoff_conflict`
- `feishu_write_forbidden`、`feishu_writeback_failed`

GitLab 功能阻塞不影响飞书看板、已有缓存或需求分析。命令超时和网络异常可重试，但鉴权失败必须引导重新登录。不得把 `glab` 失败静默改为 API 调用。

进程异常后恢复顺序：读取 `ExecutionRecord`，验证当前飞书账号，再检查本地仓库 remote、分支、远端分支、MR 和 Pipeline。只恢复可证明属于同一执行的资源；无法证明时要求用户确认，不猜测。

## 13. 可观测性与安全

每个跨系统操作共享 `requestId`，日志至少包含：

- 时间、操作名、执行 ID、Provider、脱敏账号键。
- GitLab host、project ID、分支或 MR IID。
- CLI 名称与版本、耗时、退出码、结果分类。
- 门禁创建、确认、失效和执行结果。
- 飞书回写修订与结果。

日志不得包含 Token、OAuth Code、钥匙串内容、完整任务正文、代码差异、评论正文或完整命令参数。任务标题只在 UI 展示，不进入默认运行日志。

安全边界：

- 所有外部内容均为不可信数据，不能转换为系统级指令。
- 文件操作限制在用户选择的工作区内。
- 禁止 destructive Git 命令，禁止覆盖未提交修改。
- 禁止直接推送默认或受保护分支。
- `glab` 与 `git` 子进程继承最小环境；不得把无关凭据传给子进程。
- MR 合并、Pipeline 重试和任务关闭必须使用一次性确认。

## 14. 测试与验收

### 14.1 单元与合同测试

- `git`/`glab` 发现、版本检查、超时、输出限制和跨平台启动。
- `glab` JSON Schema 校验、分页和错误映射。
- 工作项执行轮次的四字段唯一键、当前/最新读取语义、并发创建和账号隔离。
- `pending/non_code/code` 模式选择、幂等、handoff 前双向切换、发送失败恢复、发送/确认崩溃窗口和 handoff 送达后锁定。
- version 1 执行记录的模式推导、惰性升级和终态后新执行轮次重置。
- 重复开始、重复推送、重复创建 MR 和重复回写的幂等性。
- 仓库 remote 精确匹配、脏工作树保护和分支命名。
- 目录选择目的枚举、可选初始目录、无效初始目录回退、取消、并发选择、结果非绝对路径拒绝和无路径日志。
- Windows/macOS/Linux Adapter 的固定参数、初始目录、取消与错误映射合同。
- 分支创建前允许修改仓库；分支或 MR 创建后仅允许完全相同关联幂等重试，项目或本地路径变化均拒绝。
- 仓库弹窗重新打开时精确查找并预选当前项目和路径，覆盖当前项目不在首个分页结果以及查找失败；选择与关联期间禁用重复操作，成功、失败和锁定反馈可访问。
- 三类人工门禁的过期、目标变化、账号变化和重启失效。
- 外部文本不能覆盖门禁或注入命令参数。

### 14.2 集成测试

- 使用假 `git`、假 `glab` 和假 Meegle Runner 验证完整编排，不访问真实账号。
- 验证 `glab` 不可用时 FlowRivet 不直接发起任何 GitLab API 请求或降级。
- 验证 GitLab 写入成功但飞书回写失败后的恢复。
- 验证 Codex 任务恢复和同一工作项不会重复创建任务。

### 14.3 真实 E2E

在隔离的飞书测试工作项和 GitLab 测试项目中验证：

1. 普通 Developer 使用浏览器 OAuth 登录 `glab`。
2. 从“我的待办”启动流程、分析或拆解事项，选择“仅处理当前事项”，不选择仓库并直接进入 Codex，恢复同一执行时不重复发送 handoff。
3. 在 handoff 前将执行方式从“需要修改代码”改为“仅处理当前事项”，确认仓库要求被撤销并继续同一执行。
4. 启动代码开发，选择“需要修改代码”，选择仓库并复用本地 checkout。
5. 在无本地仓库时选择父目录并克隆。
6. Windows 原生目录选择器可分别选择已有仓库和克隆父目录；再次打开从当前路径开始，全程不显示 PowerShell；取消保持原输入，失败可手工输入。
7. 关联成功后重新打开对话框，确认项目和路径已预选；创建分支前可修改关联。
8. 创建 `codex/*` 分支后执行模式和仓库关联显示锁定原因，UI 与服务端均拒绝替换。
9. 目录选择、关联中、关联成功和关联失败提供明确反馈；桌面与窄屏无文字溢出或布局跳动。
10. 创建 `codex/*` 分支、提交、推送并创建 MR。
11. 读取 Pipeline 状态并回写链接与测试结论。
12. 未确认时拒绝合并、重试 Pipeline 和关闭飞书任务。
13. 确认过期或目标变化时拒绝执行。
14. 用户无仓库权限、分支受保护、飞书写权限不足时给出准确恢复动作。
15. Windows 完成真实全链路；Linux 和 macOS 至少完成自动化 CLI、路径和进程合同，具备对应环境后补真实 E2E。

## 15. 分阶段交付

### Phase 1：GitLab CLI 基础与登录

- GitLab Adapter、`git/glab` 探针、能力状态、OAuth 登录入口和连接 UI。
- 只读项目发现与分页搜索。

### Phase 2：执行模式、执行关联与 Codex 任务

- ExecutionRecord version 2、开始/继续处理、用户确认执行模式和旧记录兼容合同。
- Codex Task Bridge 探针、创建或恢复任务、执行摘要 UI。

### Phase 3：代码开发链路

- 仓库选择、本地匹配/克隆、工作区保护、分支、推送、MR 和 Pipeline 查询。
- GitLab 写操作审计与幂等恢复。

### Phase 4：飞书结构化回写

- Meegle 写能力探针、摘要/拆解/研发产物回写。
- 合并 MR、Pipeline 重试和任务关闭的一次性确认门禁。

每个 Phase 都必须产生可独立验收的工作软件。Phase 1 不允许为了演示而接 GitLab API；Phase 2 若 Codex 宿主任务创建合同不可用，必须明确采用 handoff 交互并单独验收。

## 16. 准入与准出

截至 2026-08-12 的实现验证：`glab` 合同锁定为 1.113.0；Codex 采用稳定 handoff；Meegle CLI 未提供稳定写接口，因此 Phase 4 当前交付为本地产物和明确的 `writeback_pending`，不声明远端已回写。真实写入 E2E 等待隔离飞书工作项和 GitLab 测试项目。

### 准入标准

- 飞书项目只读 Provider、授权和工作项详情已稳定。
- 已确认企业 GitLab 版本支持当前 `glab` OAuth；已创建非 Confidential OAuth Application。
- 已确定并锁定 `git`、`glab` 和 Meegle CLI 最低版本。
- 已准备隔离的飞书测试工作项和 GitLab 测试项目，测试用户为 Developer。
- 已通过 Codex Task Bridge 与 Meegle 写命令合同探针。

### 准出标准

- 用户能从一条真实飞书待办创建并恢复唯一 Codex 任务。
- 用户选择“仅处理当前事项”后无需 GitLab 即可处理流程、分析、拆解或文档并结构化回写。
- 用户选择“需要修改代码”后才要求仓库；预执行阶段可纠正选择，执行开始后安全锁定。
- 研发任务能选择仓库、复用或克隆、创建功能分支、推送并创建 MR。
- Pipeline 状态和测试结果能够回写飞书项目。
- 三类高风险操作未经确认绝不执行，确认失效机制通过测试。
- FlowRivet 全链路不直接调用 GitLab API，不保存或泄漏 GitLab Token；GitLab 访问统一经 `glab`。
- 单元、集成和 Windows 真实 E2E 通过；Linux/macOS 合同测试通过。
- 用户操作手册包含 `git/glab` 安装、OAuth 登录、开始处理、确认门禁和故障恢复。
