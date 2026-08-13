# FlowRivet 飞书执行结果自动写回设计

## 1. 背景

FlowRivet 已能从飞书项目读取当前用户的待办，并让 Codex 完成分析、文档或代码任务。当前执行产物只能保存在本地，状态停留在 `writeback_pending`。该限制来自早期 Meegle CLI 能力探针；本机 Meegle CLI 1.0.19 已提供评论创建/更新、工作项字段更新和工作流流转能力，因此可以在当前用户权限内实现真实写回。

本设计扩展 `2026-08-12-feishu-codex-gitlab-workflow-design.md`。它不改变任务读取、执行方式选择、GitLab 分支/MR 或本地结果生成流程，只替换写回阶段的本地降级实现。

## 2. 目标

- Codex 完成工作和验证后，通过结构化工具显式提交最终结果。
- 同一执行在飞书工作项中只维护一条结果评论，后续修订更新原评论。
- Codex 基于 Meegle CLI 返回的真实字段元数据和当前值提出字段更新建议。
- 普通可写字段通过服务端校验后自动更新。
- 状态、负责人、排期、正文等高影响变更必须由用户逐项确认。
- 评论成功但部分普通字段失败时保留主写回结果，并允许只重试失败字段。
- 所有步骤可恢复、幂等、按飞书账号与工作项隔离。

## 3. 非目标

- 不创建或要求预配置 FlowRivet 自定义字段。
- 不根据模糊字段名称猜测字段 key、类型或枚举值。
- 不自动流转状态、修改负责人、排期、正文、优先级、角色或工作流节点。
- 不让 Codex 自行降低字段风险等级或绕过确认。
- 不使用网页自动化、企业共享密钥或管理员身份写飞书。
- 首版不上传附件，不把超长报告拆成飞书文档。

## 4. 用户决策

| 决策 | 结果 |
| --- | --- |
| 主写回载体 | 飞书工作项评论 |
| 评论版本 | 同一 `executionId` 始终更新同一条评论 |
| 字段来源 | Meegle CLI 实时读取字段元数据和当前值 |
| 字段选择 | Codex 生成结构化建议，FlowRivet 校验和判级 |
| 自动字段 | 普通可写字段 |
| 高影响字段 | FlowRivet 中逐项勾选确认 |
| 状态流转 | 必须用户确认，不自动执行 |
| 触发时机 | Codex 完成工作与验证后显式提交最终结果 |
| 部分失败 | 评论成功即保留主写回，字段失败单独重试 |

## 5. 总体流程

```text
Codex 完成任务与验证
        |
        v
submit_execution_result
        |
        v
读取最新工作项 + 字段元数据 + 当前值 (Meegle CLI)
        |
        v
生成并校验 WritebackPlan
   |                         |
   |                         +--> 高影响字段 -> awaiting_confirmation
   v
创建/更新结果评论
   |
   v
自动更新普通字段
   |
   +--> 全成功 ----------------------> completed
   +--> 字段部分失败 -> warning ------> completed
   +--> 有待确认项 ------------------> awaiting_confirmation
   +--> 评论失败 --------------------> writeback_pending
```

评论是主写回凭证。评论未成功时不得把执行标记为已写回；评论成功后，普通字段失败不能撤销或重复创建评论。

## 6. 组件边界

### 6.1 Result Submission Tool

新增 `submit_execution_result`。Codex 必须显式调用该工具，不能由 FlowRivet 从自然语言回复中推断任务已完成。

```ts
interface SubmitExecutionResultInput {
  executionId: string;
  revision: number;
  summary: string;
  resultMarkdown: string;
  verification: {
    status: "passed" | "failed" | "not_applicable";
    commands?: string[];
    summary: string;
  };
  artifacts: Array<{
    type: "document" | "branch" | "merge_request" | "pipeline";
    title: string;
    url?: string;
  }>;
  fieldProposals: FieldProposal[];
}

type SupportedFieldValue =
  | { type: "text" | "link"; value: string | null }
  | { type: "number"; value: string | null }
  | { type: "boolean"; value: boolean | null }
  | { type: "select"; optionId: string | null }
  | { type: "multi_select"; optionIds: string[] }
  | { type: "date"; epochMilliseconds: string | null }
  | { type: "user"; userKey: string | null }
  | { type: "multi_user"; userKeys: string[] };

interface FieldProposal {
  proposalId: string;
  fieldKey: string;
  expectedCurrentValue: SupportedFieldValue;
  proposedValue: SupportedFieldValue;
  reason: string;
}
```

工具按当前 Meegle profile 与身份校验 `executionId` 对应的账号、项目和工作项。服务端对规范化输入计算 `payloadHash`；`revision` 必须单调递增，相同 revision 且 hash 相同才返回幂等结果，相同 revision 不同 hash 或旧 revision 返回稳定版本冲突。接受新 revision 时撤销旧 revision 的全部未使用确认挑战。

### 6.2 Meegle Write Adapter

扩展现有 Meegle CLI 客户端，提供窄接口：

```ts
interface FeishuWriteAdapter {
  getWriteContext(ref: WorkItemRef): Promise<WorkItemWriteContext>;
  listComments(ref: WorkItemRef): Promise<WorkItemComment[]>;
  createComment(ref: WorkItemRef, markdown: string): Promise<{ commentId: string }>;
  updateComment(ref: WorkItemRef, commentId: string, markdown: string): Promise<void>;
  updateField(ref: WorkItemRef, field: ValidatedFieldWrite): Promise<FieldWriteResult>;
  listStateTransitions(ref: WorkItemRef): Promise<StateTransition[]>;
  listStateRequiredFields(ref: WorkItemRef, transitionId: string): Promise<RequiredTransitionField[]>;
  transitionState(ref: WorkItemRef, input: ValidatedStateTransition): Promise<void>;
  getNodes(ref: WorkItemRef): Promise<WorkflowNode[]>;
  getNodeWriteMetadata(ref: WorkItemRef, nodeId: string): Promise<NodeWriteMetadata>;
  updateNode(ref: WorkItemRef, operation: ValidatedNodeWrite): Promise<void>;
}
```

普通字段实现只调用固定参数的 `workitem get`、`workitem meta-fields`、`comment list`、`comment add` 和 `workitem update`。首版每个字段使用一个独立 intent 和一次 CLI 更新，不批量合并多个字段；因此每个结果都能单独归因和重试。状态流转使用 `workflow list-state-transitions`、`workflow list-state-required` 与 `workflow transition-state`；确认前展示并校验目标状态要求的必填字段，首版无法安全补齐的必填字段使该转换标记为不可执行。节点流负责人、排期和节点字段使用 `workflow get-node`、`workflow meta-node-fields` 与 `workflow update-node`。角色修改通过 `workitem meta-roles` 和 `workitem update --role-operate`，不得伪装为字段更新。所有列表接口必须完整分页并设置总页数、总条数和响应字节上限。CLI 输出必须经过 Zod 合同解析；不得把 Codex 提供的数据直接拼入 shell。

### 6.3 Writeback Planner

Codex 的 `fieldProposals` 只是建议。Writeback Planner 使用最新元数据和当前值，为每项生成：

- 目标字段的真实 key、名称与类型；
- 当前值与建议值；
- 风险等级；
- 可写性和类型校验结果；
- 自动执行、等待确认、拒绝或已过期的决定。

未知字段、只读字段、未知类型、无权限字段或无效枚举一律拒绝。FlowRivet 不做字段名模糊匹配。若 CLI 元数据没有可验证的可写性信息，该字段不得进入自动写入，只能进入确认或拒绝状态。

### 6.4 Writeback Orchestrator

编排评论、自动字段和确认字段，逐步持久化结果。每个远端动作先持久化包含 `operationId`、profile、目标、规范化原值和目标值的 intent，再执行远端命令。SQLite 为每个 `executionId` 维护跨进程单写者 lease 和单调 fencing token；每个 revision、intent 和评论刷新都携带 token，并在每次远端动作前重新验证。新 revision 只有取得新 token 后才能开始，旧编排随即失去写权限并停止。CLI 没有 CAS，因此系统只提供写入前再次读取与尽力避免覆盖，不声称原子并发安全。恢复时先读取远端并比较规范化目标值：已达到目标则记为成功；未达到且能验证原值未变时才重放；无法可靠判断时进入人工判定，绝不自动重放。

## 7. 字段风险策略

风险等级由 FlowRivet 根据字段元数据、字段 key 和操作类型判定，Codex 不能指定。

### 7.1 可自动写入

同时满足以下条件的普通字段可以自动更新：

- 元数据明确标记当前用户可写；
- 类型是已支持的普通文本、数字、布尔、链接或低风险枚举；
- 当前值与建议中的 `expectedCurrentValue` 等价；
- 建议值通过类型、长度、选项范围和业务合同校验；
- 字段不在高影响或禁止集合中。

字段写入前必须再次读取当前值。由于读取与写入之间仍存在竞态，自动字段仅限隔离探针已证明可读回、可规范化比较且重复赋相同值无额外副作用的类型。

### 7.2 必须确认

- 状态与任何工作流流转；
- 负责人、角色和协作人；
- 计划/实际排期、工时与估分；
- 工作项正文、标题和优先级；
- 模板、节点字段及其他会改变流程语义的字段。

确认挑战绑定 `executionId`、revision、proposalId、payloadHash、Meegle profile、账号、项目、工作项、操作类别、field/node key、原值摘要、新值摘要和五分钟有效期。用户逐项勾选；未勾选项保持原值。确认前重新读取远端，任一原值或工作项版本变化时只使受影响项失效并重新生成差异。新 revision 到达、profile 切换或重新登录为其他账号时，旧挑战立即失效。

### 7.3 禁止写入

只读、系统计算、未知类型、权限不足以及 FlowRivet 尚未支持编码的字段不得写入。禁止项显示原因，但不阻塞评论写回。

## 8. 评论合同与幂等

评论使用固定 Markdown 模板：

```markdown
## FlowRivet 执行结果

**结论**
...

**验证**
- 状态：通过
- 结果：...

**产物**
- [合并请求 !123](...)

**字段更新**
- 已更新：...
- 更新失败：...
- 等待确认：...

执行 ID：...
修订版本：...
更新时间：...
<!-- flowrivet:execution=<id>;revision=<n> -->
```

首次写回使用 `comment add --action create` 并保存 `commentId`；后续修订使用 `--action update --comment-id`。评论创建同样受 execution lease 和 fencing token 保护，覆盖 FlowRivet 管理的正常多进程并发。远端创建成功但响应或本地保存不确定时，不自动再次 create；先完整分页读取 `comment list` 并查找服务端生成的隐藏执行标识。未找到时进入人工判定，找到一条则恢复，匹配到多条则停止写回并报告数据冲突。由于 Meegle CLI 没有远端创建幂等键，设计不声称在 lease 失效与远端响应丢失同时发生时绝对不可能出现重复评论，只保证检测冲突并停止继续写入。Codex 提交的 Markdown 必须先移除或转义任何 `flowrivet:` HTML 注释，幂等标识只能由服务端追加。

区分 Codex 的结果 `revision` 与评论的内部 `renderVersion`。编排器先创建包含结果和“写回处理中”的评论，普通字段批次结束、确认项被接受/拒绝/过期、失败字段重试结束后，都以相同结果 revision 增加 `renderVersion` 并更新同一评论，使“已更新、失败、等待确认”始终反映当前状态。内部评论刷新不是新的 Codex 结果修订。

评论不得包含 Token、授权码、环境变量、本机绝对路径或超出允许范围的业务数据。链接只接受经过校验的 `https` 地址和受支持的企业 GitLab/飞书域名。评论超过已探明的 CLI/服务端长度限制时停止写回并提示压缩结果；不得通过超长命令行传参。实现优先使用 CLI 支持的 JSON 输入/标准输入能力，若 1.0.19 不支持安全的长文本输入，则首版设置经过真实探针验证的保守字节上限。

## 9. 持久化与状态机

执行记录增加写回状态：

```ts
interface ExecutionWriteback {
  revision: number;
  payloadHash: string;
  comment?: {
    commentId?: string;
    state: "pending" | "written" | "failed";
    writtenRevision?: number;
    renderVersion: number;
    errorCode?: string;
  };
  automaticFieldWrites: FieldWriteRecord[];
  confirmationFieldWrites: FieldWriteRecord[];
  warnings: WritebackWarning[];
}
```

状态流转：

```text
running -> writeback_pending -> writing_back
writing_back -> completed
writing_back -> awaiting_confirmation -> completed
writing_back -> writeback_pending        (评论失败)
```

评论成功、普通字段部分失败时执行可以进入 `completed`，同时保留 `field_write_warning` 和可单独重试的失败记录，并刷新同一评论的字段状态。存在待确认字段时进入 `awaiting_confirmation`；用户全部拒绝或处理完所有选中项后刷新评论并进入 `completed`。状态 `completed` 表示本轮 FlowRivet 执行结束，不代表飞书工作项已关闭。

## 10. 错误与恢复

- OAuth 失效：保留当前步骤，重新登录后只续跑未完成操作。
- 评论创建成功但本地保存失败：用隐藏标识恢复 `commentId`。
- 字段写入部分失败：记录逐字段错误并提供单独重试；不增加结果 revision，但增加评论 `renderVersion`。
- 并发修改：字段标记 `stale`，不覆盖远端新值。
- Companion 重启：从持久化写回记录恢复，不重复成功步骤。
- CLI 返回无法识别的数据：标记稳定合同错误，不把执行伪装成成功。
- 同 revision 并发提交：只允许一个编排者执行，其他请求返回当前写回记录。
- 不同 revision 并发提交：按 `executionId` lease 串行化；旧 fencing token 在任何后续远端动作前失效。
- 字段远端成功、本地落库前崩溃：恢复时读回并按类型规范化比较；无法确认是否成功时进入人工判定。
- profile 或账号变化：暂停编排，只有恢复到原 profile 与账号后才能续跑。

## 11. UI 交互

执行详情新增“飞书写回”区域：

- 写回中：显示评论和普通字段进度；
- 成功：显示评论已写入、更新时间和字段结果；
- 部分失败：显示警告和“重试失败字段”；
- 待确认：逐项显示字段名、原值、新值与理由，用户勾选后确认；
- 已过期：显示远端数据已变化，并提供“重新加载差异”；
- 完成：明确说明写回完成不等于飞书工作项状态已关闭。

确认对话框不得嵌套在详情卡片内。键盘可操作，关闭后恢复触发按钮焦点；长字段值安全换行并可展开查看。

## 12. 权限与安全

- 所有写入使用当前用户的 Meegle OAuth，不保存或转发飞书 Token。
- 写入前校验执行、账号、项目和工作项绑定，防止跨账号写入。
- 工作项正文、评论和字段值均为不可信业务数据，不得影响系统门禁。
- Codex 只能提交建议，服务端拥有最终字段判级、验证和执行权。
- 状态流转及高影响字段使用一次性、短时、绑定当前值的确认挑战。
- 日志记录 requestId、executionId、操作类别、结果和错误码，不记录评论正文、字段敏感值或凭据。

## 13. 测试与验收

自动化覆盖：

- 评论首次创建、同执行修订更新和映射丢失恢复；
- 同 revision 幂等、旧 revision 冲突和并发提交；
- 字段不存在、只读、类型不匹配、枚举无效和权限不足；
- 普通字段自动写、高影响字段必须逐项确认；
- 确认前远端值变化导致授权失效；
- 评论成功但字段部分失败，不重复评论；
- OAuth 失效、网络失败和 Companion 重启恢复；
- 不同飞书账号、项目和工作项隔离；
- UI 的焦点、错误反馈、部分重试和窄屏布局。
- `meta-fields`、`comment list`、状态必填字段和节点列表的完整分页、上限与中途失败恢复；
- 文本、数字字符串、布尔、日期时区、枚举 optionId、用户 userKey、null/empty 和多值顺序的规范化、等价与 round-trip 编码；
- 结果 Markdown 伪造隐藏标识、Windows 命令行长度和 profile 切换防护。

真实 E2E 只使用隔离的飞书测试空间和测试工作项。验收需验证：首次创建评论、第二次更新同一评论、普通字段自动写、状态变更等待确认、确认失效重载，以及失败后只重试未完成步骤。不得在生产工作项上进行探针写入。

## 14. 分阶段交付

第一阶段分为准入探针和产品实现。准入探针必须在隔离飞书空间与测试工作项上完成真实读写，而不只运行 `--dry-run`：锁定 1.0.19 的评论 create/update/list、完整分页、字段元数据与可写性、各支持类型的单字段编码和读回、状态转换必填字段、状态流与节点流合同，并将脱敏响应保存为 fixtures 和 Zod schema。探针未证明某字段类型可写、可规范化读回且重复赋值无副作用前，该类型不得自动更新；若探针只证明评论能力，首个可发布增量仅开放评论写回。

探针通过后，第一阶段实现评论幂等写回、已证明安全的普通字段自动更新、高影响操作逐项确认、失败恢复、UI 和用户文档。状态、负责人和排期确认必须根据工作项实际模型分别走状态流、节点流或角色接口，不得统一交给 `workitem update`。

第二阶段再考虑附件、超长报告、节点字段和可配置的状态流转模板，不属于本设计首版。

## 15. 验收标准

- Codex 只能通过 `submit_execution_result` 提交最终结果。
- 正常并发和重试下，飞书工作项中只维护一条 FlowRivet 结果评论；远端不确定窗口无法证明唯一性时停止自动创建，并检测、报告重复评论冲突。
- 后续修订更新该评论，不新增重复评论。
- 普通字段只在元数据、权限、类型和原值均校验通过时自动更新。
- 状态、负责人、排期和正文未经逐项确认不会改变。
- 评论成功、字段部分失败时展示警告并可单独重试。
- 评论重试和重启不会创建重复评论；字段恢复按 intent 与远端规范化值核对，无法判定时停止自动重放并要求人工处理。
- 写回后的执行状态准确区分 `completed`、`awaiting_confirmation` 和 `writeback_pending`。
