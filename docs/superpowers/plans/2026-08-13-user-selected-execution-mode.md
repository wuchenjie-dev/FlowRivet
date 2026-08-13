# User-Selected Execution Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在每次处理飞书工作项时明确选择是否需要修改代码，取消 Codex 强制三分类，并且只在代码模式下要求关联仓库。

**Architecture:** `ExecutionRecord` 升级为带执行轮次和 `workMode` 的 version 2；执行服务负责模式切换、仓库门禁和 handoff 锁定，MCP 工具只暴露类型化命令。React UI 在发送 handoff 前收集用户选择，并用稳定 `handoffId` 处理消息发送与本地确认之间的恢复窗口。

**Tech Stack:** TypeScript 5.9、Zod 4、Node SQLite、MCP Apps、React 19、Vitest、Testing Library

**Design sources:**
- `docs/superpowers/specs/2026-08-12-feishu-codex-gitlab-workflow-design.md`
- `docs/superpowers/specs/2026-08-11-feishu-project-meegle-provider-design.md`

---

## File Responsibility Map

- `packages/codex-plugin/src/contracts/executions.ts`: 对外 version 2 Zod object、旧 version 1 持久化 schema 和执行模式合同。
- `packages/codex-plugin/src/executions/execution-record-migration.ts`: 纯函数解析并规范化持久化 payload，避免合同、SQLite 与服务各自实现迁移规则。
- `packages/codex-plugin/src/executions/execution-store.ts`: 当前执行、最新执行和轮次创建的存储接口。
- `packages/codex-plugin/src/executions/sqlite-execution-store.ts`: SQLite schema version 2 事务迁移与四字段唯一约束。
- `packages/codex-plugin/src/executions/execution-service.ts`: 模式选择、切换、锁定、仓库门禁和 handoff 确认状态机。
- `packages/codex-plugin/src/server/tools/execution-tools.ts`: MCP 工具注册、账号隔离和旧分类工具的一个版本兼容层。
- `packages/codex-plugin/src/codex/task-bridge.ts`: 生成已包含用户确认模式的稳定 handoff。
- `packages/codex-plugin/src/ui/use-work-execution.ts`: prepare、模式选择、仓库关联、消息发送、确认与恢复编排。
- `packages/codex-plugin/src/ui/components/ExecutionModeChoice.tsx`: 两种执行方式的单一、可访问选择控件。
- `packages/codex-plugin/src/ui/components/{WorkItemDetailDrawer,ExecutionSummary}.tsx`: 展示模式选择、修改入口、锁定状态和反馈。
- `packages/codex-plugin/src/ui/App.tsx`: 将新 hook 命令连接到详情与仓库对话框。

---

### Task 1: 增加 ExecutionRecord version 2 与旧 payload 兼容

**Files:**
- Modify: `packages/codex-plugin/src/contracts/executions.ts`
- Create: `packages/codex-plugin/src/executions/execution-record-migration.ts`
- Modify: `packages/codex-plugin/tests/contracts.test.ts`
- Create: `packages/codex-plugin/tests/execution-record-migration.test.ts`
- Modify mechanically: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify mechanically: `packages/codex-plugin/tests/{execution-service,execution-store,server,task-bridge,ui,workflow-e2e}.test.ts`

- [ ] **Step 1: 写 version 2 合同失败测试**

覆盖以下断言：

```ts
expect(executionRecordSchema.parse({
  ...baseRecord,
  schemaVersion: 2,
  attempt: 1,
  workMode: "pending",
})).toMatchObject({ schemaVersion: 2, attempt: 1, workMode: "pending" });

expect(executionRecordSchema.safeParse({
  ...baseRecord,
  schemaVersion: 2,
  attempt: 0,
  workMode: "automatic",
}).success).toBe(false);
```

- [ ] **Step 2: 写旧 payload 推导失败测试**

```ts
expect(migrateExecutionRecordV1(v1({
  executionKind: "pending_classification",
  state: "prepared",
}))).toMatchObject({ schemaVersion: 2, attempt: 1, workMode: "pending" });

expect(migrateExecutionRecordV1(v1({
  executionKind: "development",
  state: "awaiting_repository",
}))).toMatchObject({ workMode: "code" });

expect(migrateExecutionRecordV1(v1({
  executionKind: "requirement_analysis",
  state: "ready",
}))).toMatchObject({ workMode: "non_code" });
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/contracts.test.ts tests/execution-record-migration.test.ts
```

Expected: FAIL，提示 version 2 不被接受且迁移函数不存在。

- [ ] **Step 4: 实现最小合同与纯迁移函数**

定义：

```ts
export const executionWorkModes = ["pending", "non_code", "code"] as const;
export const executionRecordV2Schema = z.object({
  schemaVersion: z.literal(2),
  executionId: z.string().min(1),
  providerId: z.literal("feishu-project"),
  accountKey: z.string().min(1),
  workItemKey: z.string().min(1),
  attempt: z.number().int().positive(),
  taskLaunchMode: z.enum(["direct", "handoff"]),
  codexTaskId: z.string().min(1).optional(),
  codexHandoffId: z.string().min(1).optional(),
  handoffDispatchedAt: z.iso.datetime().optional(),
  workMode: z.enum(executionWorkModes),
  executionKind: z.enum(["requirement_breakdown", "requirement_analysis", "development"]).optional(),
  state: z.enum(executionStates),
  gitlab: executionRepositorySchema.optional(),
  artifacts: z.array(executionArtifactSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
```

`migrateExecutionRecordV1` 只接受已通过旧 schema 的数据，保留 ID、账号、仓库、handoff、产物和时间；`attempt=1`，按已确认规则推导 `workMode`。业务代码只消费规范化后的 `ExecutionRecordV2`。

保持 `executionRecordSchema` 为 version 2 的 `z.object(...)`，因为 MCP 工具的 `outputSchema` 依赖 `.shape`。另行导出仅用于磁盘读取的 `persistedExecutionRecordV1Schema` 和 `parsePersistedExecutionRecord(value)`；后者先识别 version，再返回统一 version 2，不能把 `executionRecordSchema` 改成 union、transform 或 preprocess。

同一提交中把源码 demo 和测试里的直接 `ExecutionRecord` 字面量机械补齐为 `schemaVersion: 2`、`attempt: 1` 和与原 `executionKind/state` 等价的 `workMode`。这里只迁移夹具，不改变状态机断言；旧数据兼容只在专用 migration 测试中保留 version 1 输入。`workItemUpdatedAt` 等现有可选字段必须继续存在于 version 2 schema。

- [ ] **Step 5: 运行测试、类型检查并确认 GREEN**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/contracts.test.ts tests/execution-record-migration.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add packages/codex-plugin/src/contracts/executions.ts packages/codex-plugin/src/executions/execution-record-migration.ts packages/codex-plugin/src/ui/demo-harness.tsx packages/codex-plugin/tests
git commit -m "feat(executions): add user-selected work modes"
git push
```

---

### Task 2: 升级执行存储并支持独立执行轮次

**Files:**
- Modify: `packages/codex-plugin/src/executions/execution-store.ts`
- Modify: `packages/codex-plugin/src/executions/sqlite-execution-store.ts`
- Modify: `packages/codex-plugin/tests/execution-store.test.ts`

- [ ] **Step 1: 写 InMemory store 轮次失败测试**

```ts
await store.create(record({ executionId: "e1", attempt: 1, state: "completed" }));
await store.create(record({ executionId: "e2", attempt: 2, state: "prepared" }));

expect((await store.findCurrent(identity))?.executionId).toBe("e2");
expect((await store.findLatest(identity))?.attempt).toBe(2);
```

同时验证同一 `attempt` 冲突，不同账号或不同工作项隔离。

- [ ] **Step 2: 写 SQLite v1 到 v2 迁移失败测试**

使用临时数据库创建当前 v1 表和一条真实 version 1 payload，再实例化 `SqliteExecutionStore`：

```ts
expect((await store.findLatest(identity))).toMatchObject({
  schemaVersion: 2,
  attempt: 1,
  workMode: "code",
});
```

验证迁移后可以插入 `attempt=2`，旧行数量不变，四字段唯一约束生效。测试不得读取或修改用户真实数据库。

- [ ] **Step 3: 运行并确认 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/execution-store.test.ts
```

Expected: FAIL，接口和 schema version 2 迁移尚不存在。

- [ ] **Step 4: 修改存储接口与内存实现**

```ts
interface ExecutionStore {
  create(record: ExecutionRecord): Promise<void>;
  findCurrent(identity: ExecutionIdentity): Promise<ExecutionRecord | undefined>;
  findLatest(identity: ExecutionIdentity): Promise<ExecutionRecord | undefined>;
  getById(executionId: string): Promise<ExecutionRecord | undefined>;
  save(record: ExecutionRecord): Promise<void>;
}
```

`findCurrent` 返回 `attempt` 最大的未终止执行；没有未终止执行时返回 `undefined`。`findLatest` 不过滤终态。

- [ ] **Step 5: 实现 SQLite 事务迁移**

在 `BEGIN IMMEDIATE` 内创建 v2 临时表、按 `attempt=1` 复制旧行、校验源/目标行数、替换表并更新 `execution_schema`。新表唯一约束：

```sql
UNIQUE(provider_id, account_key, work_item_key, attempt)
```

查询必须显式 `ORDER BY attempt DESC LIMIT 1`。解析 payload 时调用 Task 1 的兼容读取器；解析失败返回 `execution_store_read_failed`，不能当作没有记录。

- [ ] **Step 6: 运行测试与类型检查**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/execution-store.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add packages/codex-plugin/src/executions/execution-store.ts packages/codex-plugin/src/executions/sqlite-execution-store.ts packages/codex-plugin/tests/execution-store.test.ts
git commit -m "feat(executions): persist independent work attempts"
git push
```

---

### Task 3: 用 workMode 重建执行状态机

**Files:**
- Modify: `packages/codex-plugin/src/executions/execution-service.ts`
- Modify: `packages/codex-plugin/tests/execution-service.test.ts`

- [ ] **Step 1: 写模式选择与切换失败测试**

覆盖：

```ts
const prepared = await service.prepare(identityInput);
expect(prepared).toMatchObject({ attempt: 1, workMode: "pending", state: "prepared" });

expect(await service.setMode(prepared.executionId, "code"))
  .toMatchObject({ workMode: "code", state: "awaiting_repository" });
expect(await service.setMode(prepared.executionId, "non_code"))
  .toMatchObject({ workMode: "non_code", state: "ready", gitlab: undefined });
```

再验证 `non_code -> code`、相同请求幂等，以及终态后 `prepare` 创建 `attempt=2`。

- [ ] **Step 2: 写锁定和 handoff 确认失败测试**

覆盖：handoff ID 不一致、handoff 已确认、存在 branch/MR/artifact、`running` 及后续状态均拒绝切换并返回稳定错误。确认工具必须由服务端时钟生成 `handoffDispatchedAt`。

- [ ] **Step 3: 运行并确认 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/execution-service.test.ts
```

Expected: FAIL，`setMode`、`markHandoffDispatched` 和轮次 prepare 尚不存在。

- [ ] **Step 4: 实现最小状态机**

新增：

```ts
setMode(executionId: string, mode: "non_code" | "code")
markHandoffDispatched(executionId: string, handoffId: string)
```

模式可修改条件统一为 `canChangeMode(record)`，禁止在 UI 和工具层复制判断。`code` 无仓库进入 `awaiting_repository`；`non_code` 进入 `ready` 并删除尚未发生 Git 活动的临时 `gitlab`。`bindRepository` 只接受 `workMode=code`，否则返回 `execution_state_conflict`。

`prepare` 先读取 `findCurrent`；存在则恢复。不存在时读取 `findLatest`，以 `latest.attempt + 1` 创建新轮次，并在唯一约束冲突后重新读取当前执行，保证并发幂等。

- [ ] **Step 5: 运行测试并确认 GREEN**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/execution-service.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

- [ ] **Step 6: 提交**

```powershell
git add packages/codex-plugin/src/executions/execution-service.ts packages/codex-plugin/tests/execution-service.test.ts
git commit -m "feat(executions): gate repositories by user work mode"
git push
```

---

### Task 4: 更新 MCP 工具与模式化 Codex handoff

**Files:**
- Modify: `packages/codex-plugin/src/server/tools/execution-tools.ts`
- Modify: `packages/codex-plugin/src/codex/task-bridge.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`
- Modify: `packages/codex-plugin/tests/task-bridge.test.ts`

- [ ] **Step 1: 写新工具失败测试**

验证服务端注册：

```ts
set_work_item_execution_mode({ executionId, workMode: "non_code" });
mark_execution_handoff_dispatched({ executionId, handoffId });
```

两者必须检查当前飞书账号；前者只接受两种稳定模式，后者不接受客户端时间戳。`code` 未绑定仓库时 content 返回 `repository_required`。

- [ ] **Step 2: 写 handoff 内容失败测试**

`non_code` prompt 必须包含“本次无需修改代码，不要索要或猜测仓库”；`code` prompt 必须包含精确的已绑定项目和本地工作区边界。两者都不得要求 `classify_work_item_execution`。

- [ ] **Step 3: 运行并确认 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/server.test.ts tests/task-bridge.test.ts
```

- [ ] **Step 4: 注册新工具并调整 prepare 输出**

`prepare_work_item_execution` 继续返回稳定 `WorkExecutionHandoff`，但 `workMode=pending` 的 prompt 只用于 UI 暂存，不得发送。用户选模式后 UI 再调用 prepare，以相同 `handoffId` 获取模式化 prompt。

旧 `classify_work_item_execution` 保留一个发布周期：保留 `ExecutionService.classify` 作为兼容包装，`development` 走与 `setMode(code)` 相同的状态迁移，其他两类走与 `setMode(non_code)` 相同的状态迁移，并在同一次保存中记录可选 `executionKind` 标签；若 handoff 已锁定则返回 `execution_mode_locked`，不能恢复旧的错误分类锁死规则。

- [ ] **Step 5: 运行合同测试与类型检查**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/server.test.ts tests/task-bridge.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

- [ ] **Step 6: 提交**

```powershell
git add packages/codex-plugin/src/server/tools/execution-tools.ts packages/codex-plugin/src/codex/task-bridge.ts packages/codex-plugin/tests/server.test.ts packages/codex-plugin/tests/task-bridge.test.ts
git commit -m "feat(codex): hand off user-confirmed work modes"
git push
```

---

### Task 5: 在详情页增加执行方式选择与恢复交互

**Files:**
- Create: `packages/codex-plugin/src/ui/components/ExecutionModeChoice.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`
- Modify: `packages/codex-plugin/src/ui/components/ExecutionSummary.tsx`
- Modify: `packages/codex-plugin/src/ui/use-work-execution.ts`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写非代码主路径 UI 失败测试**

用户点击“交给 Codex 处理”后应只调用 prepare 并看到两个选项；点击“仅处理当前事项”后调用 `set_work_item_execution_mode`、再次 prepare、`sendUserMessage`、`mark_execution_handoff_dispatched`，且不调用仓库列表。

- [ ] **Step 2: 写代码主路径与纠错失败测试**

选择“需要修改代码”后打开仓库选择；在绑定前点击“修改执行方式”并改为非代码，仓库弹窗关闭并发送同一执行的 handoff。绑定仓库后才发送 code handoff。

- [ ] **Step 3: 写错误与锁定反馈失败测试**

覆盖：消息失败时不 mark、可重试或改模式；消息成功但 mark 失败时显示“交接状态待确认”；handoff 已确认或分支已创建时隐藏修改命令并显示锁定原因。键盘和焦点恢复必须可测试。

- [ ] **Step 4: 运行并确认 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx
```

- [ ] **Step 5: 实现 hook 编排**

将当前 `prepareAndSend` 拆为：

```ts
prepare(item)
chooseMode(item, mode)
sendAndConfirmHandoff(handoff)
retryHandoffConfirmation()
```

所有状态更新先通过 Zod 解析。`sendUserMessage` 成功后才调用 mark；mark 失败保留同一 `handoffId` 和恢复状态。仓库绑定成功复用 `sendAndConfirmHandoff`，不再发送只有 execution ID 的模糊消息。

- [ ] **Step 6: 实现轻量模式选择 UI**

使用两个单选式选项和一个明确确认按钮，不用两张嵌套卡片。文案：

- “仅处理当前事项”：流程梳理、分析、拆解、文档等，不修改代码。
- “需要修改代码”：选择仓库后由 Codex 开发和验证。

待选择时主按钮不发送；pending、success、error 使用 `role=status/alert`。控件在 390px 和桌面宽度不溢出，遵守 reduced motion。

- [ ] **Step 7: 运行 UI 测试、类型检查和构建**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
```

- [ ] **Step 8: 提交**

```powershell
git add packages/codex-plugin/src/ui packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(ui): ask users whether work needs code"
git push
```

---

### Task 6: 全链路回归、文档同步与本机插件验收

**Files:**
- Modify: `packages/codex-plugin/tests/workflow-e2e.test.ts`
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx` only if fixture gaps remain
- Modify: `docs/user-guide.md`
- Modify: `docs/superpowers/plans/2026-08-13-feishu-detail-codex-handoff.md` to mark the old classification task superseded

- [ ] **Step 1: 写两条 E2E 失败测试**

第一条：流程任务选择 `non_code`，不触发 GitLab/仓库操作，handoff 被确认且可以记录分析产物。第二条：代码任务选择 `code`，未绑定仓库时阻塞，绑定后 handoff、分支和产物沿同一 `executionId` 继续。

- [ ] **Step 2: 增加旧误分类恢复回归**

从 version 1 的 `development + awaiting_repository` 恢复，用户改选 `non_code` 后取消仓库门禁并成功发送 handoff；这直接覆盖本次用户报告。

- [ ] **Step 3: 运行并确认 RED，再补最小集成修正**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/workflow-e2e.test.ts
```

只修正跨组件合同遗漏，不在本任务重构已通过单元测试的模块。

- [ ] **Step 4: 更新用户文档与旧计划状态**

说明“是否修改代码”仅本次有效、何时可以修改、何时锁定，以及旧 `classify_work_item_execution` 已被新模式选择替代。不得再指导用户让 Codex 自动猜分类。

- [ ] **Step 5: 完整自动化验证**

```powershell
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: 全部通过，无新增 warning（Node SQLite 自身 experimental warning 除外）。

- [ ] **Step 6: 更新本机插件并记录版本**

```powershell
npm run plugin:update -- --json
```

确认返回 `ok=true`、新的 cache-busted version、Companion health 为 `ok`。UI 资源变化会要求本次重启 Codex 一次；安装该版本后，业务数据和模式切换不再依赖重启。

- [ ] **Step 7: 手工真实验收**

1. 打开真实飞书流程事项“需求自工序完结”。
2. 点击“交给 Codex 处理”，确认尚未发送消息。
3. 选择“仅处理当前事项”，确认不出现仓库对话框，Codex 收到明确 non-code handoff。
4. 新建或使用隔离代码事项，选择“需要修改代码”，确认仓库门禁正常。
5. 在 handoff 前切回非代码，确认仓库对话框关闭；handoff 后确认修改入口被锁定。
6. 重开看板，确认当前执行、模式和交接状态恢复且不重复发送。

- [ ] **Step 8: 最终提交并推送**

```powershell
git add packages/codex-plugin/tests/workflow-e2e.test.ts docs
git commit -m "test(workflow): verify user-selected execution modes"
git push
```

---

## Definition of Done

- 用户而非 Codex 决定本次是否需要修改代码。
- `non_code` 不触发任何 GitLab 或仓库选择；`code` 未绑定仓库不能开始。
- handoff 前可以纠错，handoff 或 Git 活动后安全锁定。
- version 1 执行数据无损迁移；同一工作项支持独立执行轮次。
- 消息发送与本地确认的崩溃窗口可恢复，不宣称 exactly-once。
- 新旧 MCP 工具在一个兼容周期内可共存，旧分类不再控制仓库门禁。
- 单元、合同、UI、E2E、类型检查和生产构建全部通过。
- 本机插件更新后真实飞书流程事项通过验收。
