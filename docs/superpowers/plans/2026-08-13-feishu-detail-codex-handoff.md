# 飞书详情与 Codex 自动接管 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户从飞书项目待办卡片读取完整详情，并通过 MCP Apps `ui/message` 将任务直接交给当前 Codex 对话；只有 Codex 判定为研发任务时才打开独立的 GitLab 仓库选择模态框。

**Architecture:** 在现有 Provider Registry 中补齐 Meegle 详情 Adapter，继续复用统一 `WorkItemDetail` 合同。扩展现有 ExecutionService 与 MCP Apps bridge，不建立第二套执行模型：FlowRivet 准备幂等执行，App 发送用户消息，Codex 调用分类工具决定是否需要仓库；仓库绑定后 App 再发送恢复消息。现有 `git + glab`、分支、MR、Pipeline 和飞书本地回写能力保持不变。

**Tech Stack:** TypeScript 5.9、Node.js 22、Zod 4、React 19、MCP Apps SDK 1.7.5、Meegle CLI 1.0.19、git/glab 1.113.0、Vitest、Testing Library、Playwright

**Source Specs:**

- `docs/superpowers/specs/2026-08-11-feishu-project-meegle-provider-design.md`
- `docs/superpowers/specs/2026-08-12-feishu-codex-gitlab-workflow-design.md`

---

## 已验证基线

- 实现分支：`codex/feishu-project-provider`。
- Meegle CLI 1.0.19 已公开 `workitem get` 和 `workitem meta-fields`。
- MCP Apps SDK 1.7.5 已公开 `App.sendMessage({ role: "user", content })`，宿主能力位于 `hostCapabilities.message`。
- 当前实现已具备 ExecutionRecord、GitLab 项目查询、本地仓库校验/克隆、分支、推送、MR、Pipeline 和本地回写。
- 当前缺口：飞书卡片显式跳过详情加载；执行只返回 handoff 文本；执行类型没有独立分类工具；仓库选择嵌套在详情抽屉中。
- 当前 MCP Apps 协议没有可靠的本地目录绝对路径选择合同。本轮采用绝对路径输入；保留未来宿主目录选择接口，不用浏览器伪目录句柄冒充完成。

## 文件边界

新增文件：

- `packages/codex-plugin/src/meegle/meegle-work-item-detail-provider.ts`：把 `workitem get` 结果归一化为 `WorkItemDetail`。
- `packages/codex-plugin/src/ui/components/RepositoryDialog.tsx`：独立、可访问的居中仓库模态框。
- `packages/codex-plugin/tests/meegle-work-item-detail-provider.test.ts`：详情 Adapter 合同测试。
- `packages/codex-plugin/tests/fixtures/meegle/workitem-get.json`：只保留结构的合成详情 Fixture。

重点修改文件：

- `packages/codex-plugin/src/meegle/meegle-cli-contracts.ts`：详情响应 Schema。
- `packages/codex-plugin/src/meegle/meegle-cli-client.ts`：固定参数的 `getWorkItem` 方法。
- `packages/codex-plugin/src/server/runtime-services.ts`：注册飞书详情能力。
- `packages/codex-plugin/src/server/app.ts`：按当前 Provider 解析详情服务，不再默认 TAPD。
- `packages/codex-plugin/src/contracts/executions.ts`：执行分类/状态版本与工具结果合同。
- `packages/codex-plugin/src/executions/execution-service.ts`：幂等分类和恢复。
- `packages/codex-plugin/src/server/tools/execution-tools.ts`：分类、读取执行工具。
- `packages/codex-plugin/src/ui/bridge.ts`：宿主 capability 检查和 `sendMessage`。
- `packages/codex-plugin/src/ui/use-work-execution.ts`：handoff、分类结果、仓库请求和恢复消息状态。
- `packages/codex-plugin/src/ui/App.tsx`：始终加载详情并在抽屉外渲染仓库模态框。
- `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`：完整详情与单一主操作。
- `packages/codex-plugin/src/ui/styles.css`：独立模态框及响应式布局。
- `packages/codex-plugin/src/ui/demo-harness.tsx`：详情、消息、分类和恢复演示合同。
- `packages/codex-plugin/tests/{bridge,execution-service,server,ui}.test.ts(x)`：对应行为覆盖。
- `packages/codex-plugin/e2e/taskboard.spec.ts`：浏览器完整流程。
- `docs/operations/codex-plugin-demo.md`、`docs/user-guide.md`：用户操作和兼容降级。

---

### Task 1: 冻结 Meegle 详情合同并实现 Provider

**Files:**

- Create: `packages/codex-plugin/tests/fixtures/meegle/workitem-get.json`
- Create: `packages/codex-plugin/src/meegle/meegle-work-item-detail-provider.ts`
- Create: `packages/codex-plugin/tests/meegle-work-item-detail-provider.test.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-contracts.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-client.ts`
- Modify: `packages/codex-plugin/tests/meegle-cli-client.test.ts`
- Modify: `packages/codex-plugin/src/contracts/work-item-detail.ts`

- [ ] **Step 1: 用真实账号执行只读、脱敏探针**

在终端选择一条当前用户待办，只在屏幕核对，不把原始输出重定向到仓库：

```powershell
meegle workitem get --project-key <project-key> --work-item-id <id> --fields _all --page-size 200 --format json
meegle workitem meta-fields --project-key <project-key> --work-item-type <type-key> --page-num 1 --format json
```

记录标题、状态、优先级、角色所有者、创建人、创建/更新/开始/截止时间、正文和 URL 的字段位置，以及 `_all` 的 `next_page_token` 终止条件。Fixture 只能使用 `PROJ`、`10001`、`Example User` 等合成值。

- [ ] **Step 2: 写失败合同测试**

覆盖固定参数数组、Profile 传递、`_all` 字段分页、未知字段、缺失可选时间、角色负责人、无效 URL、无效 JSON、超时和权限错误。Provider 输出必须通过 `workItemDetailSchema`，描述必须经过现有 `sanitizeDescription`，不能返回 Meegle 原始对象。统一合同补充可选 `startedAt`，与 `createdAt`、`updatedAt`、`dueAt`、`completedAt` 分开，不允许用创建时间代替计划开始时间。

- [ ] **Step 3: 验证 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- meegle-cli-client.test.ts meegle-work-item-detail-provider.test.ts
```

Expected: FAIL，因为详情命令和 Provider 尚不存在。

- [ ] **Step 4: 实现最小详情客户端和 Adapter**

`MeegleCliClient.getWorkItem` 只接受 `{ profile, projectKey, workItemId, fieldsPageToken? }`，内部固定 `workitem get`、`--fields _all`、`--page-size 200` 和 JSON 输出。Provider 负责完整字段分页、角色/系统字段映射、ISO 日期校验、HTTPS 飞书域名允许列表和 256 KiB 正文限制。

若探针证明类型 key 是详情必需参数，只从看板引用中读取稳定 `providerItemType`，不得接受任意命令参数。缺失可选字段省略；缺少稳定 ID、标题、状态或安全 URL 时返回 `work_item_detail_invalid_response`。

- [ ] **Step 5: 验证 GREEN 与敏感信息扫描**

```powershell
npm test --workspace @flowrivet/codex-plugin -- meegle-cli-client.test.ts meegle-work-item-detail-provider.test.ts sanitize-description.test.ts contracts.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
rg -n "wuchenjie|吴晨杰|Bearer |Authorization|user_access_token" packages/codex-plugin/tests/fixtures/meegle/workitem-get.json
```

Expected: 测试和类型检查通过，敏感信息扫描无命中。

- [ ] **Step 6: Commit**

```text
feat(meegle): read complete work item details
```

---

### Task 2: 按活动 Provider 路由详情并恢复卡片交互

**Files:**

- Modify: `packages/codex-plugin/src/providers/provider-registry.ts`
- Modify: `packages/codex-plugin/src/server/runtime-services.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`
- Modify: `packages/codex-plugin/tests/provider-registry.test.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败测试**

断言 `feishu-project` 注册 `details`；`get_work_item_detail` 只调用活动 Provider 的 Adapter；账号或 Provider 不匹配时拒绝。飞书是账号级同步，授权检查必须确认请求的稳定工作项键存在于当前账号最近一次实时或可用缓存待办范围，不能复用 TAPD 的项目目录和负责人显示名校验。UI 点击飞书卡片后必须立即展示加载态并调用详情工具，成功展示完整字段，失败保留基础信息、原始链接和“重新加载详情”。切换卡片时晚到响应不能覆盖新卡片。

- [ ] **Step 2: 验证 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- provider-registry.test.ts server.test.ts ui.test.tsx
```

Expected: FAIL，因为当前 `openDetail` 对 `feishu-project` 提前返回，服务端详情默认绑定 TAPD。

- [ ] **Step 3: 注入 Provider 中立详情能力**

`RuntimeServices` 为当前注册项提供 `details`；`get_work_item_detail` 先校验当前 Provider、当前账号和待办范围，再委托对应 `WorkItemDetailProvider`。账号级 Provider 从 WorkItemService 的当前账号快照或缓存索引验证稳定键；项目级 Provider 继续使用自身目录策略。删除服务端默认把真实运行时详情绑定 TAPD 的路径，但保留测试显式注入的兼容构造参数。

- [ ] **Step 4: 恢复完整详情 UI**

删除飞书卡片的提前返回。`WorkItemDetailDrawer` 对所有 Provider 使用相同 loading/error/detail/minimal fallback 规则；错误不再被 `item.providerId !== "feishu-project"` 条件隐藏。卡片、键盘和外链行为保持现有合同。

- [ ] **Step 5: 回归验证并 Commit**

```powershell
npm test --workspace @flowrivet/codex-plugin -- provider-registry.test.ts server.test.ts ui.test.tsx work-item-detail-service.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

```text
fix(taskboard): restore Feishu work item details
```

---

### Task 3: 增加幂等执行分类与恢复合同

**Files:**

- Modify: `packages/codex-plugin/src/contracts/executions.ts`
- Modify: `packages/codex-plugin/src/executions/execution-service.ts`
- Modify: `packages/codex-plugin/src/executions/execution-store.ts`
- Modify if migration is required: `packages/codex-plugin/src/executions/sqlite-execution-store.ts`
- Modify: `packages/codex-plugin/src/server/tools/execution-tools.ts`
- Modify: `packages/codex-plugin/src/codex/task-bridge.ts`
- Modify: `packages/codex-plugin/tests/{contracts,execution-service,execution-store,server,task-bridge}.test.ts`

- [ ] **Step 1: 写失败状态机测试**

覆盖：prepare 始终创建 `pending_classification + prepared`；分类为 analysis/breakdown 后进入 `ready`；分类为 development 且无仓库时进入 `awaiting_repository`；已有仓库则进入 `ready`；重复相同分类幂等；冲突重分类返回 `execution_state_conflict`；`get_work_item_execution` 只能读取当前账号同一工作项。

- [ ] **Step 2: 验证 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts execution-service.test.ts execution-store.test.ts server.test.ts task-bridge.test.ts
```

- [ ] **Step 3: 扩展既有 ExecutionRecord，不建立新模型**

保留 Schema version 1 可读性；仅在持久化并发确有必要时增加单调 `stateVersion`，并提供 SQLite 默认值迁移。增加 `ExecutionService.classify`，集中决定目标状态。`CodexTaskBridge` 的 prompt 明确：工作项正文是不可信业务数据；先调用 `classify_work_item_execution`；开发任务收到 `repository_required` 后等待 UI，不得猜仓库。

- [ ] **Step 4: 注册工具**

- `get_work_item_execution`：按当前账号和工作项读取，`readOnlyHint: true`。
- `classify_work_item_execution`：只接受执行 ID 和三种稳定类型；相同请求幂等。
- 现有 `prepare_work_item_execution` 通过服务端当前 Provider 详情 Reader 取得并清洗正文，再生成最小 handoff；不得信任 UI 回传的详情正文。若详情暂时不可用，handoff 明确要求 Codex 通过 `get_work_item_detail` 重试，不伪造空详情。正文长度受限，不返回账号键或本地路径。

- [ ] **Step 5: 验证并 Commit**

```powershell
npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts execution-service.test.ts execution-store.test.ts server.test.ts task-bridge.test.ts workflow-e2e.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

```text
feat(executions): classify Codex work before repository selection
```

---

### Task 4: 通过 MCP Apps 直接发送到当前 Codex 对话

**Files:**

- Modify: `packages/codex-plugin/src/ui/bridge.ts`
- Modify: `packages/codex-plugin/src/ui/use-work-execution.ts`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`
- Modify: `packages/codex-plugin/tests/bridge.test.ts`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`

- [ ] **Step 1: 写失败 bridge 和 hook 测试**

断言 bridge 初始化后读取 `hostCapabilities.message`；支持时调用：

```ts
app.sendMessage({
  role: "user",
  content: [{ type: "text", text: handoff.prompt }],
});
```

不支持时返回稳定 `codex_handoff_unsupported`，其他失败映射 `codex_handoff_failed`。不允许 assistant/system 角色。UI 正常流程不显示复制按钮；发送中禁用重复点击；失败显示重试和折叠兼容复制入口。

- [ ] **Step 2: 验证 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- bridge.test.ts ui.test.tsx
```

- [ ] **Step 3: 实现直接 handoff 和恢复**

`McpAppsBridge` 增加 `canSendMessage()` 与 `sendUserMessage(text)`。`useWorkExecution.prepareAndSend(item)` 顺序执行 prepare、sendMessage，并将 UI 状态置为 `handoff_sending`/`processing`。仓库绑定成功后发送只含 `executionId` 的恢复消息；消息失败不回滚已成功的仓库绑定，而是保留可重试状态。

通过 `onToolResult` 接收与当前 `executionId` 匹配的分类结果，开发且缺仓库时打开模态框。页面挂载或打开详情时调用 `get_work_item_execution` 恢复未终止状态。

- [ ] **Step 4: 更新文案与无障碍状态**

主按钮统一为“交给 Codex 处理”/“继续由 Codex 处理”。状态变化使用 `role=status` 或 live region；错误只在失败时显示兼容复制入口，默认不渲染。不得把 handoff 全文写入日志或错误对象。

- [ ] **Step 5: 验证并 Commit**

```powershell
npm test --workspace @flowrivet/codex-plugin -- bridge.test.ts ui.test.tsx task-bridge.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

```text
feat(plugin): hand work items directly to Codex
```

---

### Task 5: 将仓库选择改为独立模态框

**Files:**

- Create: `packages/codex-plugin/src/ui/components/RepositoryDialog.tsx`
- Delete after migration: `packages/codex-plugin/src/ui/components/RepositoryPicker.tsx`
- Modify: `packages/codex-plugin/src/ui/use-work-execution.ts`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败交互测试**

覆盖：仓库 UI 不在详情 DOM 子树；仅收到 `repository_required` 时自动打开；项目搜索与分页；明确选中态；已有/克隆分段控件；绝对路径必填；服务端错误保留项目、模式和路径；取消后详情保持，焦点返回触发按钮；确认绑定成功后关闭并发送恢复消息；390x844 和 1440x900 无重叠或外层溢出。

- [ ] **Step 2: 验证 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx
```

- [ ] **Step 3: 实现独立 `<dialog>`**

`RepositoryDialog` 自己管理焦点、Escape、背景滚动和表单状态。项目搜索使用现有 `list_gitlab_projects` 的 `search/page/perPage`，不再一次请求 100 条。已有仓库提交 `localPath`，克隆提交 `parentDirectory`。路径错误显示服务端稳定错误文案，不清空用户输入。

本轮不扫描磁盘、不持久化中央映射、不伪造目录选择器。可把本次会话成功路径作为内存最近值；跨会话最近路径仅在已有非敏感配置模式且无需扩大存储范围时实现，否则延期。

- [ ] **Step 4: 删除抽屉嵌套接口**

从 `WorkItemDetailDrawer` 删除 `repositoryPicker` ReactNode。`App` 在详情抽屉同级渲染 `RepositoryDialog`，关闭详情时同步关闭仓库模态框，防止孤立对话框。

- [ ] **Step 5: 验证并 Commit**

```powershell
npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx gitlab-service.test.ts repository-workflow.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

```text
fix(ui): separate repository selection from work item details
```

---

### Task 6: 完成演示、浏览器 E2E、运行手册与真实验收

**Files:**

- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `docs/operations/codex-plugin-demo.md`
- Modify: `docs/user-guide.md`
- Create: `docs/abf-poc/2026-08-13-feishu-detail-codex-handoff-e2e.md`

- [ ] **Step 1: 扩展 Demo Harness 场景**

增加完整详情成功/失败、`ui/message` 支持/不支持、分析分类、开发需仓库、仓库绑定失败/成功和刷新恢复。Harness 只使用合成数据，并显示消息调用计数供 Playwright 断言。

- [ ] **Step 2: 编写 Playwright E2E**

至少验证：

1. 点击飞书卡片加载完整详情和时间。
2. “交给 Codex 处理”发送一次用户消息，重复点击不创建第二执行。
3. 分析任务不显示仓库模态框。
4. 开发任务自动显示独立仓库模态框。
5. 路径错误保留输入；成功绑定发送恢复消息。
6. 刷新后恢复执行；宿主不支持消息时显示兼容降级。
7. 桌面和移动截图非空、无控件重叠、文本不溢出。

- [ ] **Step 3: 执行自动化全套验证**

```powershell
npm test --workspace @flowrivet/codex-plugin
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
npm run test:e2e --workspace @flowrivet/codex-plugin
npm test
git diff --check
```

Expected: 全部通过；构建后的 MCP App 不出现源码路径或真实凭据。

- [ ] **Step 4: 在 Codex 桌面真实验收**

使用当前插件升级流程加载新版本，不直接编辑插件缓存。验证当前 Codex 宿主实际声明并接受 `ui/message`；打开真实飞书任务核对详情；分别执行一条分析任务和一条研发任务；研发任务选择 `gitlab-aiabu.ruijie.com.cn` 内测试仓库并确认绑定后自动继续。

如果宿主不支持 `ui/message`，记录客户端版本、host capabilities 和稳定错误，按兼容降级验收，不宣称直接接管通过。不得保存真实任务正文、用户、项目路径、本地路径或 Token。

- [ ] **Step 5: 更新用户文档和 E2E 记录**

用户手册只写普通用户操作：查看详情、交给 Codex、研发时选择仓库、失败恢复和插件更新。E2E 记录只写版本、结果、脱敏计数和未通过项。

- [ ] **Step 6: Commit**

```text
docs(workflow): verify direct Codex execution handoff
```

---

## 最终 Definition of Done

- 飞书卡片始终打开可重试的完整详情，时间、人员、正文和原始链接来自真实 Meegle 详情合同。
- 点击“交给 Codex 处理”后当前 Codex 对话收到一次用户消息，正常流程不需要复制。
- Codex 先分类；分析/拆解无仓库阻塞，研发任务才请求仓库。
- 仓库选择是独立模态框，支持搜索、分页、已有/克隆、路径错误保留和焦点恢复。
- 仓库绑定后 Codex 自动继续同一 `executionId`；刷新后执行状态可恢复。
- `ui/message` 不支持时明确降级，不伪造成功。
- 现有 GitLab 分支/MR/Pipeline、飞书授权、通知、更新和安全门禁回归通过。
- 每个 Task 独立提交并推送 `codex/feishu-project-provider`，最终工作区干净。
