# FlowRivet 飞书执行结果自动写回 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Codex 提交的最终执行结果自动、可恢复地写入飞书工作项评论和已验证安全的普通字段，并让状态、负责人、排期和正文等高影响变更经过用户逐项确认。

**Architecture:** 先用隔离飞书空间锁定 Meegle CLI 1.0.19 的真实写合同；随后由类型化 Result Submission、Writeback Planner 和持久化 Writeback Orchestrator 分离建议、判级与远端执行。SQLite 为每个执行维护 revision、intent、lease 和 fencing token；Meegle Adapter 每次只执行一个字段或一个工作流操作，评论使用隐藏标识恢复并通过 renderVersion 维护同一条评论。

**Tech Stack:** TypeScript 5.9、Zod 4、Node.js 22 SQLite、Meegle CLI 1.0.19、MCP Apps、React 19、Vitest、Testing Library、Playwright

**Source Spec:** `docs/superpowers/specs/2026-08-13-feishu-execution-writeback-design.md`

---

## File Responsibility Map

- `scripts/probe-meegle-write-contract.mjs`: 只对显式指定的隔离工作项执行真实读写探针。
- `packages/codex-plugin/src/contracts/writeback.ts`: submission、字段值和 writeback 合同。
- `packages/codex-plugin/src/writeback/write-capability-manifest.ts`: deny-by-default 能力清单合同、加载与版本校验。
- `packages/codex-plugin/src/writeback/meegle-write-capabilities.json`: 由隔离探针生成并人工复核的已证明能力；未列出的类型一律关闭。
- `packages/codex-plugin/src/meegle/meegle-write-adapter.ts`: 固定参数 CLI 写适配器和完整分页。
- `packages/codex-plugin/src/writeback/field-value-codec.ts`: 字段值规范化、比较和编码。
- `packages/codex-plugin/src/writeback/writeback-planner.ts`: automatic/confirmation/rejected/stale 判级。
- `packages/codex-plugin/src/writeback/sqlite-writeback-store.ts`: writeback、intent、lease、fencing 和确认持久化。
- `packages/codex-plugin/src/writeback/writeback-orchestrator.ts`: revision 串行化、远端写入和恢复。
- `packages/codex-plugin/src/server/tools/writeback-tools.ts`: submission、查询、重试和确认工具。
- `packages/codex-plugin/src/ui/components/ExecutionWriteback.tsx`: 写回进度和结果。
- `packages/codex-plugin/src/ui/components/FieldConfirmationDialog.tsx`: 高影响变更逐项确认。

## Delivery Gate

Task 1 是硬准入。只证明评论则只发布评论写回；只为真实探针证明安全的字段类型启用自动更新；状态、节点或角色合同未证明时只能展示建议并标记不可执行。不得在生产工作项运行探针，也不得用 dry-run 冒充真实能力。

---

### Task 1: 锁定 Meegle CLI 真实写合同

**Files:**
- Create: `scripts/probe-meegle-write-contract.mjs`
- Create: `packages/codex-plugin/src/writeback/write-capability-manifest.ts`
- Create: `packages/codex-plugin/src/writeback/meegle-write-capabilities.json`
- Create: `packages/codex-plugin/tests/meegle-write-probe.test.ts`
- Create: `packages/codex-plugin/tests/fixtures/meegle/write/README.md`
- Create after real probe: `packages/codex-plugin/tests/fixtures/meegle/write/*.json`
- Modify: `packages/codex-plugin/tests/probe-contracts.test.ts`
- Modify: `docs/abf-poc/2026-08-12-feishu-codex-gitlab-e2e.md`

- [ ] **Step 1: 写安全边界失败测试**

覆盖缺少 project/work item/隔离确认时拒绝、目标标题无测试标记时拒绝，以及输出不含正文、Token、邮箱或字段原值。能力清单 schema 固定 `cliVersion`、`probeVersion`、`comment`、逐字段类型 `fieldTypes`、state/node/role 和 `verifiedAt`；未知字段或缺失 manifest 默认关闭。

```ts
expect(() => parseProbeArgs([])).toThrow("isolated_fixture_required");
expect(redactProbeOutput(raw)).not.toContain("secret result");
```

- [ ] **Step 2: 运行并确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/meegle-write-probe.test.ts tests/probe-contracts.test.ts`

Expected: FAIL，探针模块不存在。

- [ ] **Step 3: 实现隔离探针**

固定顺序：auth/profile -> workitem get -> meta-fields 全量分页 -> comment list 全量分页 -> create/update 同一随机 nonce 评论 -> 对每个显式 `--field-fixture <type>:<fieldKey>:<testValue>` 逐一执行写入/读回/相同值重复写/恢复 -> 查询 state transitions/required fields -> 查询节点/角色元数据。恢复失败返回非零和 `manual_cleanup_required=true`。禁止自动状态流转、负责人、排期、正文和角色修改。探针生成候选 manifest；只有人工复核后才复制到运行时 JSON。

- [ ] **Step 4: 运行单元测试和 help**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/meegle-write-probe.test.ts tests/probe-contracts.test.ts`

Run: `node scripts/probe-meegle-write-contract.mjs --help`

Expected: PASS；help 明确只允许隔离测试工作项。

- [ ] **Step 5: 使用用户提供的隔离工作项运行真实探针**

Run: `node scripts/probe-meegle-write-contract.mjs --project-key <TEST_PROJECT_KEY> --work-item-id <TEST_WORK_ITEM_ID> --field-fixture text:<FIELD_KEY>:<TEST_VALUE> --confirm-isolated-fixture FLOWRIVET_WRITE_PROBE --output docs/abf-poc/meegle-write-contract-1.0.19.json --manifest-output <TEMP_MANIFEST_PATH>`

Expected: 评论 create/update/list 成功；只为明确 fixture 的类型记录字段能力；写入、读回、重复赋相同值和原值恢复均成功才启用该类型。缺少隔离目标时停止，不猜测。

- [ ] **Step 6: 脱敏固化 fixtures 并更新 POC**

只保存结构、类型、分页和错误码，替换全部业务 ID。人工复核候选 manifest 后写入 `meegle-write-capabilities.json`；运行时加载器校验 CLI/probe 版本，异常或未列出类型一律关闭。将旧“CLI 不支持写入”改为逐能力实测状态。

- [ ] **Step 7: 提交并推送**

Stage: `scripts/probe-meegle-write-contract.mjs`、相关 tests/fixtures 和 POC。

Commit: `test(meegle): probe isolated write contracts`

---

### Task 2: 增加类型化写回合同与字段值编码

**Files:**
- Create: `packages/codex-plugin/src/contracts/writeback.ts`
- Create: `packages/codex-plugin/src/writeback/field-value-codec.ts`
- Create: `packages/codex-plugin/tests/writeback-contracts.test.ts`
- Create: `packages/codex-plugin/tests/field-value-codec.test.ts`
- Modify: `packages/codex-plugin/src/contracts/executions.ts`

- [ ] **Step 1: 写 submission 合同失败测试**

```ts
expect(submitExecutionResultSchema.parse({
  executionId: "e1", revision: 1, summary: "done", resultMarkdown: "result",
  verification: { status: "passed", summary: "ok" }, artifacts: [],
  fieldProposals: [{ proposalId: "p1", fieldKey: "result_link",
    expectedCurrentValue: { type: "link", value: null },
    proposedValue: { type: "link", value: "https://gitlab-aiabu.ruijie.com.cn/x" },
    reason: "publish result" }],
})).toBeTruthy();
```

覆盖 unknown 值、类型不一致、非 HTTPS、重复 proposalId、超长 Markdown 和伪造 marker。

- [ ] **Step 2: 写 codec 失败测试**

覆盖 text/link/number/boolean/select/multi-select/date/user/multi-user 的 null/empty、数字字符串、日期毫秒、optionId、userKey、数组去重排序和 round-trip。

- [ ] **Step 3: 运行并确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/writeback-contracts.test.ts tests/field-value-codec.test.ts`

- [ ] **Step 4: 实现严格 union 与纯 codec**

实现 `normalizeFieldValue`、`equalFieldValue`、`encodeFieldValue`；不支持类型返回 `field_type_unsupported`，禁止任意 JSON.stringify 兜底。

- [ ] **Step 5: 验证**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/writeback-contracts.test.ts tests/field-value-codec.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

- [ ] **Step 6: 提交并推送**

Commit: `feat(writeback): add typed result contracts`

---

### Task 3: 实现 Meegle 写适配器

**Files:**
- Create: `packages/codex-plugin/src/meegle/meegle-write-contracts.ts`
- Create: `packages/codex-plugin/src/meegle/meegle-write-adapter.ts`
- Create: `packages/codex-plugin/tests/meegle-write-adapter.test.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-client.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-contracts.ts`
- Modify: `packages/codex-plugin/tests/meegle-cli-client.test.ts`

- [ ] **Step 1: 写固定命令和分页失败测试**

断言评论 create/update/list、meta-fields、workitem get、单字段 update、state transitions/required、node metadata/update 和 role metadata/operate 的精确参数。每次带固定 profile/project/workItem；列表翻页设 100 页、10,000 条和字节上限。

- [ ] **Step 2: 写安全与错误映射失败测试**

覆盖参数注入、超长评论、unauthorized/unavailable/timeout/invalid response。评论内容只能通过 args 或探针证明的安全输入通道，不拼 shell command。

- [ ] **Step 3: 运行并确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/meegle-write-adapter.test.ts tests/meegle-cli-client.test.ts`

- [ ] **Step 4: 实现最小适配器**

只消费 Task 1 fixtures 已证明字段。`updateField` 每次只接受一个字段；状态、节点、角色独立方法；required fields 无法支持时不调用 transition。

- [ ] **Step 5: 验证并提交**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/meegle-write-adapter.test.ts tests/meegle-cli-client.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Commit: `feat(meegle): add verified write adapter`

---

### Task 4: 持久化 writeback、intent、lease 与 fencing

**Files:**
- Create: `packages/codex-plugin/src/writeback/writeback-store.ts`
- Create: `packages/codex-plugin/src/writeback/sqlite-writeback-store.ts`
- Create: `packages/codex-plugin/src/writeback/create-writeback-store.ts`
- Create: `packages/codex-plugin/tests/writeback-store.test.ts`
- Modify: `packages/codex-plugin/src/executions/confirmation-service.ts`
- Modify: `packages/codex-plugin/src/server/runtime-services.ts`
- Modify: `packages/codex-plugin/tests/confirmation-service.test.ts`

- [ ] **Step 1: 写 revision、intent 和结果失败测试**

覆盖同 revision/hash 幂等、同 revision 不同 hash 和旧 revision 冲突、新 revision 撤销旧挑战、每字段一个 intent、comment renderVersion 和逐字段结果。

- [ ] **Step 2: 写 lease/fencing 失败测试**

```ts
const first = await store.acquireLease("e1", "worker-a", now);
const second = await store.acquireLease("e1", "worker-b", afterExpiry);
expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
await expect(store.assertFence("e1", first.fencingToken))
  .rejects.toMatchObject({ code: "writeback_fence_lost" });
```

覆盖续租、过期接管、跨数据库实例、旧 token 不能保存和崩溃恢复。

- [ ] **Step 3: 运行并确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/writeback-store.test.ts tests/confirmation-service.test.ts`

- [ ] **Step 4: 实现独立 SQLite schema**

在与 `executions.db` 同一配置目录创建独立 `writebacks.db`，由 `createWritebackStore()` 唯一拥有。schema version 从 1 开始，未知/更高版本拒绝启动；每次迁移使用 `BEGIN IMMEDIATE`、临时表、行数校验和原子 version 更新。增加新建、关闭重开、未知版本、失败回滚和旧数据库无 writeback 文件的升级测试。大段内容不进入 execution payload。

- [ ] **Step 5: 持久化高影响确认**

新增 `WritebackConfirmationStore` 端口供写回确认使用，不改现有内存 `ConfirmationService` 的 MR/Pipeline 合同。`createDefaultRuntimeServices()` 创建一个共享 writeback store，并同时注入 orchestrator 与 writeback confirmation service，保证同一数据库和时钟。写回确认绑定 execution/revision/proposal/hash/profile/account/work item/operation/原新值摘要/expiresAt，一次性事务消费。

- [ ] **Step 6: 锁定 lease/fencing SQL 和时序**

lease 记录包含 `execution_id`、`owner_id`（Companion instanceId + 随机 workerId）、`fencing_token`、`expires_at`。默认 lease 30 秒，CLI timeout 上限前不能只依赖后台定时器；每个远端动作前在事务中续租到 `now + 30s`，动作返回后再次 assert fence。`acquire` 在 `BEGIN IMMEDIATE` 内对 nil/expired/same-owner 分支执行 compare-and-update，并只在新 owner 接管时递增 token。所有 writeback/intent/comment mutation 使用 `WHERE execution_id=? AND fencing_token=?` 或同事务 assert，changes != 1 返回 `writeback_fence_lost`。clock、lease duration 和 ownerId 全部可注入测试。

- [ ] **Step 7: 验证并提交**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/writeback-store.test.ts tests/confirmation-service.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Commit: `feat(writeback): persist intents and fencing leases`

---

### Task 5: 实现字段规划器和评论渲染器

**Files:**
- Create: `packages/codex-plugin/src/writeback/writeback-planner.ts`
- Create: `packages/codex-plugin/src/writeback/comment-renderer.ts`
- Create: `packages/codex-plugin/tests/writeback-planner.test.ts`
- Create: `packages/codex-plugin/tests/comment-renderer.test.ts`

- [ ] **Step 1: 写风险判级失败测试**

探针证明的普通字段 -> automatic；状态、负责人、角色、排期、正文、标题、优先级、模板和节点字段 -> confirmation；只读/未知/无权限/未验证能力 -> rejected。Codex 不能提交或降低风险等级。

- [ ] **Step 2: 写 stale 和 required fields 失败测试**

expectedCurrentValue 不等于最新值时 stale；状态转换存在未支持 required field 时 `confirmation_unexecutable`，不创建挑战。

- [ ] **Step 3: 写评论渲染失败测试**

覆盖 pending/written/warning/awaiting confirmation/completed，marker 只能由服务端生成，输入 marker 被移除，本机路径/敏感模式脱敏，非法链接不渲染。相同 result revision 的 renderVersion 更新反映最终字段状态。

- [ ] **Step 4: 运行并确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/writeback-planner.test.ts tests/comment-renderer.test.ts`

- [ ] **Step 5: 实现纯函数 planner/renderer**

Planner 输入完整元数据、当前值和 capability manifest，不执行 I/O；Renderer 只消费已校验 plan/result。

- [ ] **Step 6: 验证并提交**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/writeback-planner.test.ts tests/comment-renderer.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Commit: `feat(writeback): plan safe Feishu updates`

---

### Task 6: 实现写回编排和 MCP 工具

**Files:**
- Create: `packages/codex-plugin/src/writeback/writeback-orchestrator.ts`
- Create: `packages/codex-plugin/src/server/tools/writeback-tools.ts`
- Create: `packages/codex-plugin/tests/writeback-orchestrator.test.ts`
- Modify: `packages/codex-plugin/src/server/runtime-services.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/src/server/tools/execution-tools.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`
- Modify: `packages/codex-plugin/tests/writeback-workflow.test.ts`

- [ ] **Step 1: 写 submission/revision 失败测试**

验证 `submit_execution_result` 的账号/profile/work item 绑定、payloadHash、幂等 revision 和 fencing。客户端不能提交 commentId、风险等级、fence 或 written 状态。

- [ ] **Step 2: 写评论和字段编排失败测试**

覆盖首次 create、修订 update、响应丢失后 list 恢复、重复 marker 冲突、每字段 intent、写前重读、目标值已存在时恢复、无法判断时人工判定、字段部分失败只 warning。评论恢复还必须覆盖：无保存 ID 且 marker 零匹配进入 `comment_write_uncertain` 并禁止 create；comment list 任一分页失败时 retryable pause 并禁止 create；已保存 ID 的 update not-found 后先完整 marker scan；空/畸形 ID 走 scan；一匹配恢复，多匹配 `comment_conflict`。

- [ ] **Step 3: 写跨 revision 并发失败测试**

让 revision 1 在远端调用前暂停，接受 revision 2 获得新 fence；revision 1 恢复后必须在下一远端动作前 `writeback_fence_lost`，不能覆盖 revision 2。

- [ ] **Step 4: 写确认和重试工具失败测试**

注册 `get_execution_writeback`、`retry_failed_writeback_fields`、`prepare_writeback_confirmations`、`confirm_writeback_fields`、`reject_writeback_fields`。确认只消费选中 challengeIds；执行前重读，stale 不写。

- [ ] **Step 5: 运行并确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/writeback-orchestrator.test.ts tests/server.test.ts tests/writeback-workflow.test.ts`

- [ ] **Step 6: 实现编排器和工具装配**

用新工具替代 `write_execution_result` local-only 主路径；旧工具保留一个版本作为无 fieldProposals 的兼容包装。Task 1 未验证能力由 manifest 关闭。

- [ ] **Step 7: 验证并提交**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/writeback-orchestrator.test.ts tests/server.test.ts tests/writeback-workflow.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Commit: `feat(writeback): synchronize Codex results to Feishu`

---

### Task 7: 增加写回状态与逐项确认 UI

**Files:**
- Create: `packages/codex-plugin/src/ui/use-execution-writeback.ts`
- Create: `packages/codex-plugin/src/ui/components/ExecutionWriteback.tsx`
- Create: `packages/codex-plugin/src/ui/components/FieldConfirmationDialog.tsx`
- Modify: `packages/codex-plugin/src/ui/components/ExecutionSummary.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写写回状态 UI 失败测试**

覆盖 writing、comment written、field warning、awaiting confirmation、stale、manual review、completed。完成文案说明“结果已写回，不代表飞书工作项已关闭”。

- [ ] **Step 2: 写逐项确认失败测试**

展示字段名、原值、新值和理由；默认不勾选；只提交选中 challengeIds；取消不写；stale/unexecutable 禁选；关闭恢复焦点。

- [ ] **Step 3: 写重试和恢复失败测试**

“重试失败字段”只调用 retry，不重新 submit、不创建评论。重新打开详情调用 get 恢复状态。

- [ ] **Step 4: 运行并确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx`

- [ ] **Step 5: 实现紧凑 UI**

写回区域位于详情，确认对话框独立渲染。使用 checkbox；390px 和桌面不溢出，长值折行/展开。

- [ ] **Step 6: 验证并提交**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Run: `npm run build --workspace @flowrivet/codex-plugin`

Commit: `feat(ui): show Feishu writeback progress`

---

### Task 8: 全链路回归、文档与本机验收

**Files:**
- Modify: `packages/codex-plugin/tests/workflow-e2e.test.ts`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `docs/user-guide.md`
- Modify: `docs/operations/codex-plugin-demo.md`
- Modify: `docs/abf-poc/2026-08-12-feishu-codex-gitlab-e2e.md`

- [ ] **Step 1: 写自动化 E2E**

非代码结果 -> create comment -> completed；代码 revision 2 -> update same comment -> safe field + confirmation -> stale recheck -> complete；评论成功字段失败 -> warning -> 单字段重试且不重复评论。

- [ ] **Step 2: 写恢复 E2E**

覆盖 Companion 重启、commentId 丢失、marker 零匹配/分页失败/update not-found、旧 fence 停止、profile 切换暂停和远端不确定窗口人工判定。

- [ ] **Step 3: 更新用户文档**

说明自动评论、字段建议来源、自动字段边界、逐项确认、状态不会自动关闭、部分失败和重新登录恢复；删除“不支持自动写回”。

- [ ] **Step 4: 完整自动化验证**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `git diff --check`

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: Playwright PASS，覆盖只提交选中项、取消不写、stale/expired 重载、失败重试不重新 submit/create、重启恢复。

Expected: 全部通过；只允许既有 SQLite experimental / Vite deprecation warning。

- [ ] **Step 5: 隔离飞书真实 E2E**

验证首次 create、revision 2 update 同一评论、安全普通字段、状态逐项确认、确认过期和失败字段重试。只保存脱敏 requestId、计数和结果。

- [ ] **Step 6: 更新本机插件和 Companion**

Run: `npm run plugin:update -- --json`

Run: `Invoke-RestMethod http://127.0.0.1:43120/health | ConvertTo-Json -Compress`

- [ ] **Step 7: 提交并推送**

Commit: `docs(writeback): verify Feishu synchronization`

---

## Final Acceptance Checklist

- [ ] `submit_execution_result` 是新主入口，旧工具仅兼容包装。
- [ ] revision/hash 幂等，跨 revision 由 lease/fencing 串行化。
- [ ] 正常流程只维护一条评论；远端不确定时停止自动 create 并报告冲突。
- [ ] 每个普通字段独立 intent/命令/结果，只启用真实探针证明安全的类型。
- [ ] 状态、负责人、排期、正文和节点操作未经逐项确认不会执行。
- [ ] required fields 无法安全补齐时在确认前标记不可执行。
- [ ] 评论成功、字段部分失败不回滚，重试不重新 submit 或 create comment。
- [ ] profile/账号变化、重启和字段并发修改都有明确恢复状态。
- [ ] UI、文档、自动 E2E 与隔离真实 E2E 一致。
