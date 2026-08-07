# Read-only Work Item Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打开 FlowRivet 看板时自动聚合当前 TAPD 用户在全部可访问项目中的真实需求、任务和缺陷，无需选择项目，并以只读方式展示。

**Architecture:** 在现有项目目录之上增加 Provider 中立的工作项端口和同步服务，TAPD Adapter 负责分页、字段解析和错误归一化，MCP Server 负责组合目录与工作项快照。React UI 只消费统一快照，删除项目选择门槛和 Demo 行为；单项目失败返回部分结果，全部失败返回稳定错误。

**Tech Stack:** TypeScript 5.9、Node.js 22、Zod 4、MCP Apps、React 19、Vitest、Testing Library、Playwright

---

## 文件结构

### 新建

- `packages/codex-plugin/src/work-items/work-item-provider.ts`：Provider 中立的工作项读取端口、查询结果和稳定错误。
- `packages/codex-plugin/src/work-items/work-item-service.ts`：有限并发、单飞、部分失败和最近 7 天过滤。
- `packages/codex-plugin/src/work-items/tapd-work-item-provider.ts`：TAPD Story、Task、Bug 的分页读取、精确负责人匹配和字段映射。
- `packages/codex-plugin/src/observability/work-item-operation-logger.ts`：只记录聚合计数和稳定错误码的脱敏日志。
- `packages/codex-plugin/tests/work-item-service.test.ts`：同步服务单元测试。
- `packages/codex-plugin/tests/tapd-work-item-provider.test.ts`：TAPD Adapter 合约测试。

### 修改

- `packages/codex-plugin/src/contracts/taskboard.ts`：增加同步摘要、只读标识和同步错误 Schema。
- `packages/codex-plugin/src/projects/project-catalog-service.ts`：发现成功后自动启用全部可用项目，失败时使用缓存。
- `packages/codex-plugin/src/server/app.ts`：组合真实同步服务，注册只读刷新工具，移除 Demo 快照。
- `packages/codex-plugin/src/ui/App.tsx`：删除项目选择门槛、真实刷新、部分失败和全失败状态。
- `packages/codex-plugin/src/ui/components/ProjectSidebar.tsx`：移除“管理项目”，保留全部项目过滤。
- `packages/codex-plugin/src/ui/components/TaskBoard.tsx`：固定只读模式，不触发拖动回调。
- `packages/codex-plugin/src/ui/components/TaskColumn.tsx`：向卡片传递只读状态。
- `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`：显示真实类型、状态和只读交互。
- `packages/codex-plugin/src/ui/demo-harness.tsx`：提供成功、部分失败、全失败的本地夹具。
- `packages/codex-plugin/tests/contracts.test.ts`：快照 Schema 测试。
- `packages/codex-plugin/tests/project-catalog-service.test.ts`：自动启用与缓存回退测试。
- `packages/codex-plugin/tests/server.test.ts`：MCP 工具、真实快照和日志脱敏测试。
- `packages/codex-plugin/tests/ui.test.tsx`：自动进入看板、刷新和错误状态测试。
- `packages/codex-plugin/e2e/taskboard.spec.ts`：Phase 1C 浏览器验收。

## 实现约束

- 不在本阶段注册或调用任何 TAPD 写接口。
- 工作项核心模型不得包含 TAPD 专有包装结构。
- 自动化测试只使用合成 ID、标题和 Token；真实 Token 只存在于本机安全存储。
- 每类 TAPD 列表请求使用 `limit=200`，页码从 1 开始，返回不足 200 条时终止。
- 负责人按分号拆分、去空格后与当前账号精确相等，不做包含匹配。
- 项目并发上限先固定为 4；同一个服务实例同时只允许一个同步。
- 全部项目失败时抛出 `work_item_sync_failed`，不得返回误导性空成功。

### Task 1: 扩展 Provider 中立合同

**Files:**
- Create: `packages/codex-plugin/src/work-items/work-item-provider.ts`
- Modify: `packages/codex-plugin/src/contracts/taskboard.ts`
- Test: `packages/codex-plugin/tests/contracts.test.ts`

- [ ] **Step 1: 写失败的合同测试**

在 `contracts.test.ts` 增加快照断言：`readOnly: true`、`syncSummary` 包含成功/失败项目数，工作项允许 `completedAt`，全部失败错误码只允许 `work_item_sync_failed`。

```ts
expect(taskboardSnapshotSchema.parse(snapshot)).toMatchObject({
  readOnly: true,
  syncSummary: { successfulProjects: 2, failedProjects: 1, itemCount: 3 },
});
expect(taskboardSnapshotSchema.safeParse({ ...snapshot, readOnly: false }).success).toBe(false);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts`

Expected: FAIL，提示 `readOnly` 或 `syncSummary` 尚未定义。

- [ ] **Step 3: 定义工作项端口和 Schema**

`work-item-provider.ts` 至少导出以下边界：

```ts
export type WorkItemQueryResult = {
  projectExternalId: string;
  items: WorkItem[];
  failedKinds: WorkItemKind[];
};

export interface WorkItemProvider {
  readonly id: string;
  listProjectWorkItems(input: {
    projectExternalId: string;
    accountDisplayName: string;
  }): Promise<WorkItemQueryResult>;
}

export class WorkItemProviderError extends Error {
  constructor(readonly code: "work_item_sync_failed" | "provider_unauthorized") {
    super(code);
    this.name = "WorkItemProviderError";
  }
}
```

在 `taskboard.ts` 增加 `completedAt?: string`、固定 `readOnly: z.literal(true)`、`syncSummary` 和可选 `syncErrorCode`；保留已有 Provider 中立字段。

- [ ] **Step 4: 运行合同测试和类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts`

Expected: PASS。

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 5: 提交合同**

```bash
git add packages/codex-plugin/src/contracts/taskboard.ts packages/codex-plugin/src/work-items/work-item-provider.ts packages/codex-plugin/tests/contracts.test.ts
git commit -m "feat(taskboard): define read-only work item contracts"
```

### Task 2: 自动启用全部可访问项目

**Files:**
- Modify: `packages/codex-plugin/src/projects/project-catalog-service.ts`
- Test: `packages/codex-plugin/tests/project-catalog-service.test.ts`

- [ ] **Step 1: 写失败的自动启用测试**

覆盖四个行为：新发现项目 `selected=true`、既有可用项目也强制启用、读取旧缓存时把可用项目迁移为启用、发现失败时仍返回迁移后的缓存目录及原有连接错误。

```ts
expect((await service.discover()).projects).toEqual([
  expect.objectContaining({ externalId: "A", selected: true, available: true }),
  expect.objectContaining({ externalId: "B", selected: true, available: true }),
]);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- project-catalog-service.test.ts`

Expected: FAIL，新项目当前仍为 `selected=false`。

- [ ] **Step 3: 最小修改目录合并逻辑**

发现结果和缓存结果中的所有可用项目固定写入 `selected: true`；失去权限的历史项目保留为 `available: false`，同步层只以 `available` 作为纳入条件，绝不再以旧选择值过滤。保留 `saveSelection` 和 `addProject` 代码以兼容旧客户端，但 Phase 1C UI 和打开工具不再调用它们。

- [ ] **Step 4: 运行项目目录测试**

Run: `npm test --workspace @flowrivet/codex-plugin -- project-catalog-service.test.ts project-selection-store.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交自动项目目录**

```bash
git add packages/codex-plugin/src/projects/project-catalog-service.ts packages/codex-plugin/tests/project-catalog-service.test.ts
git commit -m "feat(projects): automatically enable accessible projects"
```

### Task 3: 实现 TAPD 只读工作项 Adapter

**Files:**
- Create: `packages/codex-plugin/src/work-items/tapd-work-item-provider.ts`
- Test: `packages/codex-plugin/tests/tapd-work-item-provider.test.ts`

- [ ] **Step 1: 写失败的分页与请求测试**

使用注入的 `fetcher` 和凭据解析器验证：

- 依次请求 `/stories`、`/tasks`、`/bugs`。
- 请求包含 `workspace_id`、负责人参数、`limit=200`、`page`。
- 第一页 200 条时读取第二页；不足 200 条时停止。
- 401、403、5xx、超时和异常 JSON 映射为稳定错误。

```ts
expect(urls[0]).toContain("/stories?workspace_id=100&owner=alice&limit=200&page=1");
expect(urls).toContainEqual(expect.stringContaining("page=2"));
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- tapd-work-item-provider.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现通用分页请求器**

构造 `TapdWorkItemProvider`，复用 `TapdProjectCredentialResolver`，但不把 Token 暴露给服务层。每种类型独立捕获错误并写入 `failedKinds`；认证错误直接终止并抛出 `provider_unauthorized`。

```ts
for (let page = 1; ; page += 1) {
  const rows = await requestPage({ path, workspaceId, owner, page, limit: 200 });
  collected.push(...rows);
  if (rows.length < 200) break;
}
```

- [ ] **Step 4: 写失败的字段映射测试**

分别提供扁平和 `Story`/`Task`/`Bug` 包装响应，验证：

- owner/current_owner 以 `;` 精确拆分。
- requirement/task/defect 类型映射。
- 外链、标题、优先级、截止时间映射；完成时间只读取经真实探针确认的类型字段，无法确认时不伪造。
- 未识别状态保留原值并进入 `todo`。
- 已解决缺陷进入 `in_review`，已关闭进入 `done`。

- [ ] **Step 5: 实现解析器和状态映射**

解析器使用结构化对象读取，不对 JSON 正文做字符串替换。每条记录先验证稳定 ID、标题和精确负责人，再转换为 `WorkItem`；缺少必需字段的单条记录跳过，不中断整页。

- [ ] **Step 6: 运行 Adapter 测试和类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- tapd-work-item-provider.test.ts tapd-project-provider.test.ts`

Expected: PASS。

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 7: 提交 TAPD Adapter**

```bash
git add packages/codex-plugin/src/work-items/tapd-work-item-provider.ts packages/codex-plugin/tests/tapd-work-item-provider.test.ts
git commit -m "feat(tapd): read assigned stories tasks and bugs"
```

### Task 4: 实现聚合同步服务

**Files:**
- Create: `packages/codex-plugin/src/work-items/work-item-service.ts`
- Test: `packages/codex-plugin/tests/work-item-service.test.ts`

- [ ] **Step 1: 写失败的过滤与聚合测试**

使用假 Provider 和固定时钟验证：所有未完成项保留；完成项仅保留最近 7 天；缺少可信完成时间的完成项排除；项目计数按 `projectExternalId` 汇总。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- work-item-service.test.ts`

Expected: FAIL，服务尚不存在。

- [ ] **Step 3: 实现最小同步服务**

服务输入为连接身份和所有 `available` 项目，输出 `items`、每项目计数及同步摘要。以 4 个 worker 消费项目队列，不引入新依赖。

```ts
const workerCount = Math.min(4, projects.length);
await Promise.all(Array.from({ length: workerCount }, () => consumeNextProject()));
```

- [ ] **Step 4: 写失败的部分失败、全部失败与单飞测试**

验证一个项目失败仍返回其他项目；任一类型失败时该项目计入 `failedProjects` 但保留成功类型的数据，只有三种类型均成功才计入 `successfulProjects`；所有项目均有类型失败且没有任何可用结果时抛出 `work_item_sync_failed`；并发调用 `sync()` 返回同一个进行中 Promise，Provider 每项目只调用一次。

- [ ] **Step 5: 实现失败语义和单飞**

保存 `inFlight?: Promise<WorkItemSnapshot>`，在 `finally` 中清除。部分成功返回失败项目数；全部失败抛出稳定错误。Phase 1C 不落盘工作项快照。

- [ ] **Step 6: 运行同步服务测试**

Run: `npm test --workspace @flowrivet/codex-plugin -- work-item-service.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交同步服务**

```bash
git add packages/codex-plugin/src/work-items/work-item-service.ts packages/codex-plugin/tests/work-item-service.test.ts
git commit -m "feat(taskboard): aggregate read-only work items"
```

### Task 5: 接入 MCP Server 与脱敏日志

**Files:**
- Create: `packages/codex-plugin/src/observability/work-item-operation-logger.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Test: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: 写失败的 MCP 工具测试**

注入假 `ProjectCatalog` 和假 `WorkItemService`，验证 `open_my_taskboard` 会先发现全部项目再同步；增加 `list_my_work_items` 和 `refresh_my_work_items`，三者输出都通过同一 `taskboardSnapshotSchema`，且标记 `readOnlyHint: true`。

- [ ] **Step 2: 运行 Server 测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- server.test.ts`

Expected: FAIL，仍返回 Demo 数据且新工具未注册。

- [ ] **Step 3: 组合真实服务并移除 Demo 路径**

在 `createTaskboardServer` 中创建 `TapdWorkItemProvider` 和 `WorkItemService`。连接成功时调用 `projectCatalog.discover()`；从全部 `available` 项目同步；断开时返回空的只读快照。三个读取工具复用一个 `buildTaskboardSnapshot()`，不得接收项目 ID 参数。

- [ ] **Step 4: 写失败的错误与日志测试**

验证部分失败仍返回结构化快照；全部失败返回稳定 MCP 错误；序列化日志不包含用户、项目 ID/名称、工作项 ID/标题、URL、Token 或响应正文，只包含 requestId、工具名、Provider ID、耗时和计数。

- [ ] **Step 5: 实现工作项操作日志**

```ts
export interface WorkItemOperationEvent {
  requestId: string;
  tool: "open_my_taskboard" | "list_my_work_items" | "refresh_my_work_items";
  providerId: string;
  outcome: "success" | "partial" | "error";
  durationMs: number;
  successfulProjects: number;
  failedProjects: number;
  itemCount: number;
  errorCode?: string;
}
```

- [ ] **Step 6: 运行 Server 测试和类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- server.test.ts`

Expected: PASS。

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 7: 提交 MCP 集成**

```bash
git add packages/codex-plugin/src/server/app.ts packages/codex-plugin/src/observability/work-item-operation-logger.ts packages/codex-plugin/tests/server.test.ts
git commit -m "feat(plugin): expose real read-only taskboard tools"
```

### Task 6: 将 React 看板切换为真实只读体验

**Files:**
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/ProjectSidebar.tsx`
- Modify: `packages/codex-plugin/src/ui/components/TaskBoard.tsx`
- Modify: `packages/codex-plugin/src/ui/components/TaskColumn.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败的自动进入和真实刷新测试**

已连接快照应直接显示看板，不渲染项目选择页；点击刷新调用 `refresh_my_work_items` 并替换快照；页面不出现“Demo 数据”或“管理项目”。

- [ ] **Step 2: 写失败的只读与错误状态测试**

验证卡片不可拖动；部分失败显示非阻塞警告和数据；全部失败显示重试状态而不是“0 个待办”；空成功显示明确空状态。

- [ ] **Step 3: 运行 UI 测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx`

Expected: FAIL，当前仍渲染项目选择和 Demo 文案。

- [ ] **Step 4: 删除选择门槛和本地移动逻辑**

从 `App.tsx` 删除 `ProjectSelector`、`needsProjectSelection`、`managingProjects`、`moveItem` 和项目写工具调用。刷新使用 `refresh_my_work_items`；登录成功后重新打开看板。`TaskBoard` 固定 `disabled={true}`，不再接收产生本地状态变化的 `onMove`。

- [ ] **Step 5: 实现同步状态呈现**

标题区显示工作项数、项目数、最后同步时间和“只读”。部分失败显示失败项目数量；全失败保留连接菜单与重试按钮。侧栏只提供全部、即将到期、已逾期和项目过滤。

- [ ] **Step 6: 更新本地 Harness 场景**

Harness 使用 Provider 中立合成数据，支持查询参数或控件切换 `success`、`partial`、`error`，但不得重新引入 Demo 标识到生产 UI。

- [ ] **Step 7: 运行 UI 测试和生产构建**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx bridge.test.ts`

Expected: PASS。

Run: `npm run build --workspace @flowrivet/codex-plugin`

Expected: PASS，并生成单文件 MCP Apps UI。

- [ ] **Step 8: 提交 UI**

```bash
git add packages/codex-plugin/src/ui packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(ui): show real read-only taskboard"
```

### Task 7: 浏览器验收、全量验证与真实 TAPD 探针

**Files:**
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-06-tapd-my-work-taskboard-design.md`（仅当探针确认字段与规格不同）

- [ ] **Step 1: 更新失败的 Playwright 场景**

覆盖 1440×900 和 390×844：已连接后直接进入看板、四列可见、项目过滤、真实刷新、部分失败、全失败重试、卡片不可拖动、无 Demo/项目选择入口、文字无重叠。

- [ ] **Step 2: 运行 E2E 并确认失败**

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: FAIL，直到 Harness 和 UI 完整匹配 Phase 1C。

- [ ] **Step 3: 修正最小 E2E 夹具或可访问性问题**

只修复测试暴露的实际产品问题；不要为测试增加生产环境专用分支。

- [ ] **Step 4: 运行完整自动化验证**

Run: `npm test`

Expected: 所有 Vitest 测试 PASS。

Run: `npm run typecheck`

Expected: 所有 workspace 类型检查 PASS。

Run: `npm run build`

Expected: 所有 workspace 构建 PASS。

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: 所有 Playwright 场景 PASS。

- [ ] **Step 5: 执行真实 TAPD 脱敏只读探针**

使用本机已安全保存的个人 Token 启动 Companion，在 Codex 中打开看板并确认：项目自动出现；至少一种真实工作项可见；重新打开无需刷新或选择；TAPD 中没有产生状态变更。终端只检查 requestId、计数和错误码，不复制响应正文或身份数据到仓库。

- [ ] **Step 6: 提交验收测试**

```bash
git add packages/codex-plugin/e2e/taskboard.spec.ts
git commit -m "test(taskboard): cover read-only sync flows"
```

- [ ] **Step 7: 确认工作区和提交历史**

Run: `git status --short`

Expected: 无输出。

Run: `git log --oneline -7`

Expected: 每个实现任务都有独立、可回退的提交。

## 最终准出

- 打开或重新进入看板即可自动发现并使用全部可访问项目。
- 需求、任务、缺陷均通过个人 Token 直接读取 TAPD API，不依赖第三方 CLI 或 MCP。
- 只展示当前用户精确负责的未完成项和最近 7 天可信完成项。
- 单项目失败可降级，全部失败不伪装为空数据。
- UI、MCP 工具和日志中不存在 Token、身份、项目或工作项敏感明细。
- 看板保持只读，不发起任何 TAPD 写请求。
- 单元测试、合约测试、类型检查、构建、Playwright 和真实只读验收均通过。
