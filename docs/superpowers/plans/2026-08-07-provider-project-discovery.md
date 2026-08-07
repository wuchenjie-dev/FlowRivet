# Provider-Neutral Project Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录 TAPD 后通过 OpenAPI 发现真实项目，让用户明确选择项目并跨 Companion 重启恢复，同时保持项目目录、MCP 合同和 UI 对未来 Provider 中立。

**Architecture:** 新增 `ProjectManagementProvider`、`ProjectCatalogService` 和 `ProjectSelectionStore` 三个边界。`TapdProjectProvider` 是首个 Adapter，直接使用 DPAPI 中的个人 Token 调用 TAPD API；通用服务和 UI 只处理 `providerId + externalId`，不接触 Token 或 TAPD 响应结构。

**Tech Stack:** TypeScript 5.9、Node.js 22、Zod 4、MCP SDK、React 19、Vitest、Testing Library、Playwright、Windows DPAPI、TAPD OpenAPI

---

## File Map

- Create `packages/codex-plugin/src/contracts/projects.ts`: Provider 中立的连接、项目目录、选择和错误 Schema。
- Modify `packages/codex-plugin/src/contracts/taskboard.ts`: 将 Demo 工作项和项目快照迁移到 Provider 中立字段，并携带项目目录状态。
- Modify `packages/codex-plugin/src/demo/fixtures.ts`: 生成符合新合同的 Provider 中立 Demo 数据。
- Create `packages/codex-plugin/src/projects/project-selection-store.ts`: 项目选择存储接口、错误和不支持平台之外的通用约束。
- Create `packages/codex-plugin/src/projects/json-project-selection-store.ts`: 版本化 JSON、原子写入、读取和清理。
- Create `packages/codex-plugin/src/projects/tapd-project-provider.ts`: TAPD 项目发现、项目解析、权限验证和错误映射。
- Create `packages/codex-plugin/src/projects/project-catalog-service.ts`: 发现结果合并、选择保存、手动添加和 Provider 清理。
- Create `packages/codex-plugin/src/observability/project-operation-logger.ts`: 项目工具的 requestId 和白名单结构化日志。
- Modify `packages/codex-plugin/src/server/app.ts`: 依赖注入项目服务，注册三个通用 MCP 工具，并让看板快照使用真实项目。
- Create `packages/codex-plugin/src/ui/components/ProjectSelector.tsx`: 搜索、勾选、全选当前结果、重新发现和手动添加。
- Modify `packages/codex-plugin/src/ui/App.tsx`: 在未选择项目时显示选择页，保存后进入 Demo 看板，并提供管理项目入口。
- Modify `packages/codex-plugin/src/ui/components/ProjectSidebar.tsx`: 使用 Provider 中立项目 ID，并提供“管理项目”操作。
- Modify `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`: 使用 `externalId/projectName` 等通用字段。
- Modify `packages/codex-plugin/src/ui/demo-harness.tsx`: 模拟项目发现、保存和手动添加工具。
- Modify `packages/codex-plugin/src/ui/styles.css`: 项目选择页的紧凑响应式布局。
- Create `packages/codex-plugin/tests/project-selection-store.test.ts`: 存储恢复和原子性测试。
- Create `packages/codex-plugin/tests/tapd-project-provider.test.ts`: TAPD 合同与错误测试。
- Create `packages/codex-plugin/tests/project-catalog-service.test.ts`: 使用假 Provider 验证核心层中立性和合并规则。
- Modify `packages/codex-plugin/tests/contracts.test.ts`: 新 Schema 与敏感字段约束。
- Modify `packages/codex-plugin/tests/server.test.ts`: 三个 MCP 工具、快照和断开清理测试。
- Modify `packages/codex-plugin/tests/ui.test.tsx`: 项目选择完整交互测试。
- Modify `packages/codex-plugin/e2e/taskboard.spec.ts`: 浏览器项目选择与失败保留测试。
- Modify `docs/operations/codex-plugin-demo.md`: Phase 1B 安装、使用、文件位置和只读验收。

### Task 1: Provider-Neutral Contracts And Demo Migration

**Files:**
- Create: `packages/codex-plugin/src/contracts/projects.ts`
- Modify: `packages/codex-plugin/src/contracts/taskboard.ts`
- Modify: `packages/codex-plugin/src/demo/fixtures.ts`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/ProjectSidebar.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`
- Test: `packages/codex-plugin/tests/contracts.test.ts`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: Write failing contract tests for Provider-neutral fields**

Add assertions that `projectCatalogSchema` accepts `providerId/externalId` and rejects serialized secrets, and change the work-item fixture expectation from `tapdId/workspaceId` to `providerId/externalId/projectExternalId`:

```ts
const catalog = projectCatalogSchema.parse({
  provider: { providerId: "tapd", displayName: "TAPD", state: "connected" },
  projects: [{
    providerId: "tapd",
    externalId: "50396062",
    name: "FlowRivet 测试项目",
    selected: false,
    available: true,
    source: "discovered",
    lastVerifiedAt: "2026-08-07T00:00:00.000Z",
  }],
  stale: false,
});
expect(JSON.stringify(catalog)).not.toMatch(/token|authorization/i);
expect(workItemSchema.parse({
  key: "tapd:50396062:requirement:10001",
  providerId: "tapd",
  externalId: "10001",
  projectExternalId: "50396062",
  projectName: "FlowRivet 测试项目",
  kind: "requirement",
  providerItemType: "story",
  title: "项目发现",
  stage: "todo",
  providerStatus: "planning",
  externalUrl: "https://www.tapd.cn/50396062/prong/stories/view/10001",
})).toMatchObject({ kind: "requirement" });
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts ui.test.tsx`

Expected: FAIL because `projects.ts` and Provider-neutral work-item fields do not exist.

- [ ] **Step 3: Add the project contracts and migrate the taskboard contract**

Define these exact public shapes in `contracts/projects.ts`:

```ts
export const providerConnectionSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  state: z.enum(["disconnected", "connected", "expired"]),
  accountDisplayName: z.string().optional(),
  tenantDisplayName: z.string().optional(),
});

export const projectRefSchema = z.object({
  providerId: z.string().min(1),
  externalId: z.string().min(1),
  name: z.string().min(1),
  prettyName: z.string().optional(),
  selected: z.boolean(),
  available: z.boolean(),
  source: z.enum(["discovered", "manual"]),
  lastVerifiedAt: z.iso.datetime(),
});

export const projectCatalogSchema = z.object({
  provider: providerConnectionSchema,
  projects: z.array(projectRefSchema),
  stale: z.boolean(),
  errorCode: z.enum([
    "provider_not_connected", "provider_unauthorized", "provider_unavailable",
    "project_discovery_unavailable", "project_not_found", "project_forbidden",
    "selection_store_failed",
  ]).optional(),
});

export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export type ProjectRef = z.infer<typeof projectRefSchema>;
export type ProjectCatalogResult = z.infer<typeof projectCatalogSchema>;
```

Change `workItemKinds` to `requirement/task/defect/other`; add the fields from Step 1; replace taskboard `projects` with selected `ProjectRef` entries plus `count`, and add `projectCatalog` to `taskboardSnapshotSchema`. Update fixtures and UI property access mechanically without adding project-selection behavior yet.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts ui.test.tsx && npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS; the existing Demo board renders with Provider-neutral fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/codex-plugin/src/contracts packages/codex-plugin/src/demo/fixtures.ts packages/codex-plugin/src/ui packages/codex-plugin/tests/contracts.test.ts packages/codex-plugin/tests/ui.test.tsx
git commit -m "refactor(taskboard): make project contracts provider neutral"
```

### Task 2: Atomic Project Selection Store

**Files:**
- Create: `packages/codex-plugin/src/projects/project-selection-store.ts`
- Create: `packages/codex-plugin/src/projects/json-project-selection-store.ts`
- Test: `packages/codex-plugin/tests/project-selection-store.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Cover missing files, round-trip, replacement, Provider clearing, invalid JSON, and failed rename preserving the previous file. The central round-trip assertion is:

```ts
const store = new JsonProjectSelectionStore({ directory });
await store.save("tapd", [{
  providerId: "tapd",
  externalId: "50396062",
  name: "ABF 产品研发",
  selected: true,
  available: true,
  source: "discovered",
  lastVerifiedAt: now,
}]);
await expect(store.load("tapd")).resolves.toEqual([
  expect.objectContaining({ externalId: "50396062", selected: true }),
]);
expect(await readFile(join(directory, "project-selections.json"), "utf8"))
  .not.toMatch(/token|authorization/i);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- project-selection-store.test.ts`

Expected: FAIL because the store modules do not exist.

- [ ] **Step 3: Implement the store interface and versioned JSON format**

Use this interface and on-disk envelope:

```ts
export interface ProjectSelectionStore {
  load(providerId: string): Promise<ProjectRef[]>;
  save(providerId: string, projects: ProjectRef[]): Promise<void>;
  clear(providerId: string): Promise<void>;
}

type StoredSelections = {
  version: 1;
  providers: Record<string, ProjectRef[]>;
};
```

Write `${path}.${randomUUID()}.tmp`, then `rename` to `project-selections.json`. Map parse/read/write failures to `ProjectSelectionStoreError("selection_store_failed")`; missing files return `[]`; cleanup temporary files on failure.

Implement `resolveFlowRivetConfigDirectory()` with deterministic platform paths: Windows uses `LOCALAPPDATA\FlowRivet` and rejects a missing `LOCALAPPDATA`; macOS uses `~/Library/Application Support/FlowRivet`; Linux uses `$XDG_CONFIG_HOME/flowrivet` when set, otherwise `~/.config/flowrivet`. Use `node:os` `homedir()` rather than reading `HOME` directly. Add table tests for all paths.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test --workspace @flowrivet/codex-plugin -- project-selection-store.test.ts`

Expected: PASS with no leftover temporary files.

- [ ] **Step 5: Commit**

```bash
git add packages/codex-plugin/src/projects packages/codex-plugin/tests/project-selection-store.test.ts
git commit -m "feat(projects): persist provider project selections"
```

### Task 3: TAPD Project Provider Via OpenAPI

**Files:**
- Create: `packages/codex-plugin/src/projects/project-management-provider.ts`
- Create: `packages/codex-plugin/src/projects/tapd-project-provider.ts`
- Test: `packages/codex-plugin/tests/tapd-project-provider.test.ts`

- [ ] **Step 1: Write failing TAPD contract tests**

Inject `fetcher` and a credential resolver returning `{ token, accountDisplayName }`. Assert discovery calls the exact endpoint with Bearer auth, filters organization nodes, and never puts the token in thrown errors:

```ts
expect(fetcher).toHaveBeenCalledWith(
  "https://api.tapd.cn/workspaces/user_participant_projects?nick=wuchenjie",
  expect.objectContaining({
    headers: expect.objectContaining({ authorization: "Bearer personal-token" }),
  }),
);
await expect(provider.discoverProjects()).resolves.toEqual([{
  externalId: "50396062",
  name: "ABF 产品研发",
  prettyName: "abf",
}]);
```

Add table cases for 401/403/500, network failure, invalid JSON, `status !== 1`, pure numeric ID, `/tapd_fe/50396062/...`, `/50396062/...`, not found and forbidden.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- tapd-project-provider.test.ts`

Expected: FAIL because the Provider files do not exist.

- [ ] **Step 3: Implement the generic Provider interface**

```ts
export interface ProjectManagementProvider {
  readonly id: string;
  readonly displayName: string;
  getConnection(): Promise<ProviderConnection>;
  discoverProjects(): Promise<ExternalProject[]>;
  resolveProject(input: string): Promise<ExternalProject>;
}
```

Implement `TapdProjectProvider` with a 15-second `AbortSignal.timeout(15_000)`. Parse `Workspace` wrappers or flat records. Treat only records with an ID, non-organization category, and absent/`normal` status as discoverable. `resolveProject` extracts the workspace ID, then calls `/workspaces/get_workspace_info?workspace_id=<encoded id>`.

Define the Adapter-private credential boundary in the same module:

```ts
export interface TapdProjectCredentialResolver {
  resolve(): Promise<{ token: string; accountDisplayName: string }>;
}
```

The default resolver receives the existing `CredentialStore` and `TapdIdentityValidator`, reads the DPAPI credential, validates it, and returns the Token only to `TapdProjectProvider`. It maps missing credentials to `provider_not_connected`; no generic project type may import this interface.

Map errors to `ProjectProviderError` codes without retaining response bodies, URLs containing `nick`, or credentials:

```ts
401 -> provider_unauthorized
403 -> project_forbidden for resolve, provider_unauthorized for discover
404 -> project_not_found
5xx/network/timeout/invalid JSON -> provider_unavailable
status !== 1 -> project_discovery_unavailable or project_not_found
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test --workspace @flowrivet/codex-plugin -- tapd-project-provider.test.ts && npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS, and serialized errors do not contain the test Token.

- [ ] **Step 5: Commit**

```bash
git add packages/codex-plugin/src/projects packages/codex-plugin/tests/tapd-project-provider.test.ts
git commit -m "feat(tapd): discover projects through OpenAPI"
```

### Task 4: Provider-Neutral Project Catalog Service

**Files:**
- Create: `packages/codex-plugin/src/projects/project-catalog-service.ts`
- Test: `packages/codex-plugin/tests/project-catalog-service.test.ts`

- [ ] **Step 1: Write failing service tests with a fake Provider**

Test these rules independently of TAPD:

```ts
// Saved A remains selected, discovered B starts unselected, missing C becomes unavailable.
await expect(service.discover()).resolves.toMatchObject({
  projects: [
    { externalId: "A", selected: true, available: true },
    { externalId: "B", selected: false, available: true },
    { externalId: "C", selected: true, available: false },
  ],
  stale: false,
});
```

Also cover saved catalog returned with `stale=true` after Provider failure, rejecting unknown/unavailable IDs during save, manual add remaining unselected, duplicate manual add merging, and `clear()` removing only the current Provider.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- project-catalog-service.test.ts`

Expected: FAIL because `ProjectCatalogService` does not exist.

- [ ] **Step 3: Implement deterministic merge and selection logic**

Expose exactly:

```ts
export interface ProjectCatalog {
  getCatalog(): Promise<ProjectCatalogResult>;
  discover(): Promise<ProjectCatalogResult>;
  saveSelection(externalIds: string[]): Promise<ProjectCatalogResult>;
  addProject(input: string): Promise<ProjectCatalogResult>;
  clear(): Promise<void>;
}
```

Sort available projects by locale name then external ID, followed by unavailable projects. On discovery failure, return saved entries unchanged with `stale=true` and the stable error code. Never overwrite the store when Provider discovery fails. `saveSelection` must reject IDs not present and available in the current catalog.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test --workspace @flowrivet/codex-plugin -- project-catalog-service.test.ts`

Expected: PASS using only the fake Provider and fake store.

- [ ] **Step 5: Commit**

```bash
git add packages/codex-plugin/src/projects/project-catalog-service.ts packages/codex-plugin/tests/project-catalog-service.test.ts
git commit -m "feat(projects): add provider-neutral project catalog"
```

### Task 5: MCP Tools And Real Project Snapshots

**Files:**
- Create: `packages/codex-plugin/src/observability/project-operation-logger.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: Write failing MCP tests**

Inject a fake `ProjectCatalog` through `TaskboardMcpServerOptions` and assert the tool list contains `discover_projects`, `save_project_selection`, and `add_project`, none with UI metadata. Call each tool and validate structured content with `projectCatalogSchema`.

Add assertions that `open_my_taskboard` returns selected real catalog projects with count `0`, and that `disconnect_tapd` calls both `authService.disconnect()` and `projectCatalog.clear()`. For account switching, compare the pre-login and post-login `userName + companyName`; assert a successful login with a different identity clears the old catalog before the next discovery. When TAPD omits company information, a changed user name still clears the catalog; an indistinguishable same-nick cross-company switch remains a documented TAPD identity limitation and manual disconnect is the safe path.

Inject a capture logger and assert every project tool emits one completion event containing `requestId`, tool name, `providerId`, outcome and duration, while serialized events do not contain Token, account name, project name, project ID, input URL or upstream response body.

- [ ] **Step 2: Run server tests and verify RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- server.test.ts`

Expected: FAIL because tools and `projectCatalog` injection are missing.

- [ ] **Step 3: Register tools and compose default dependencies**

Create one credential store and one identity client in `createTaskboardMcpServer`; share them between `TapdAuthService` and `TapdProjectProvider`. Register:

```ts
discover_projects({ providerId })
save_project_selection({ providerId, externalIds: z.array(z.string().min(1)) })
add_project({ providerId, input: z.string().min(1) })
```

Reject a `providerId` other than the active Provider with `provider_not_connected`. Return only `projectCatalogSchema` data. In `open_my_taskboard`, load the catalog without forcing network discovery; if no selected projects exist, return no Demo items. If selections exist, map catalog projects into the taskboard sidebar and retain clearly marked Demo items without attributing them to a real project.

Keep Demo items under `providerId="demo"` and `projectExternalId="demo"`; do not relabel them as belonging to a real selected project. They appear only in “全部待办”, while filtering a real project correctly yields an empty board until the next phase reads real work items.

Implement the logger as a small injected boundary:

```ts
export interface ProjectOperationLogger {
  completed(event: {
    requestId: string;
    tool: "discover_projects" | "save_project_selection" | "add_project";
    providerId: string;
    outcome: "success" | "error";
    durationMs: number;
    errorCode?: string;
  }): void;
}
```

Generate `requestId` with `randomUUID()` inside each handler. The default logger writes one JSON line to stderr; it receives no request arguments or response content.

- [ ] **Step 4: Run server tests and full typecheck**

Run: `npm test --workspace @flowrivet/codex-plugin -- server.test.ts && npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS; MCP responses do not contain credentials or TAPD-specific project fields.

- [ ] **Step 5: Commit**

```bash
git add packages/codex-plugin/src/server/app.ts packages/codex-plugin/tests/server.test.ts
git commit -m "feat(plugin): expose project catalog tools"
```

### Task 6: Project Selection UI

**Files:**
- Create: `packages/codex-plugin/src/ui/components/ProjectSelector.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/ProjectSidebar.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Cover:

```ts
expect(screen.getByRole("heading", { name: "选择项目" })).toBeVisible();
await user.type(screen.getByRole("searchbox", { name: "搜索项目" }), "ABF");
await user.click(screen.getByRole("checkbox", { name: "选择项目：ABF 产品研发" }));
await user.click(screen.getByRole("button", { name: "使用 1 个项目" }));
expect(bridge.callTool).toHaveBeenCalledWith("save_project_selection", {
  providerId: "tapd",
  externalIds: ["50396062"],
});
```

Also test re-discovery retaining checked entries, select-all affecting only filtered available rows, unavailable rows disabled, manual add through `add_project`, save failure staying on selector, and sidebar “管理项目” returning to the selector.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx`

Expected: FAIL because `ProjectSelector` and project tools are not wired.

- [ ] **Step 3: Implement the selection experience**

`ProjectSelector` receives only `ProjectCatalogResult` and callbacks. Use a search input, native checkboxes, an icon refresh button with tooltip, an inline manual-add form, and one primary save button. Do not nest cards. Disable save until at least one available project is checked.

In `App`, derive these top-level states:

```ts
const needsProjectSelection = connection.tapd === "connected"
  && projectCatalog.projects.every((project) => !project.selected || !project.available);
const [managingProjects, setManagingProjects] = useState(needsProjectSelection);
```

After save, apply the returned catalog, call `open_my_taskboard`, and enter the board. On discovery failure with saved projects, keep rows visible and show a stale status. Add “管理项目” to the unframed sidebar footer.

- [ ] **Step 4: Run UI tests and browser build**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx && npm run build --workspace @flowrivet/codex-plugin`

Expected: PASS; the single-file UI bundle builds without external assets.

- [ ] **Step 5: Commit**

```bash
git add packages/codex-plugin/src/ui packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(taskboard): add provider project selection"
```

### Task 7: Browser E2E And Failure States

**Files:**
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`

- [ ] **Step 1: Add failing E2E scenarios**

Extend the harness with `projects-unselected`, `projects-selected`, and `projects-stale`. Add tests that:

- discover two projects and enter the board after selecting one;
- reopen with the selected project already in the sidebar;
- preserve the catalog and show stale status when discovery fails;
- add a project URL manually;
- keep the selector usable at 900x700 with no incoherent overlap.

- [ ] **Step 2: Run E2E and verify RED**

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: new project scenarios FAIL before harness tool responses are implemented.

- [ ] **Step 3: Implement deterministic harness tool responses**

Return `projectCatalogSchema` structured content for all three project tools. Mutate only harness-local selected IDs so save and reopen-in-current-frame behavior is realistic. Do not place even placeholder Token values in screenshots, traces, URLs, or harness console output.

- [ ] **Step 4: Run all E2E and inspect screenshots on failure**

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: all existing login/board tests and new project tests PASS at both viewports.

- [ ] **Step 5: Commit**

```bash
git add packages/codex-plugin/src/ui/demo-harness.tsx packages/codex-plugin/e2e/taskboard.spec.ts
git commit -m "test(taskboard): cover project discovery lifecycle"
```

### Task 8: Operations, Real Read-Only Validation, And Plugin Refresh

**Files:**
- Modify: `docs/operations/codex-plugin-demo.md`
- Modify: `.codex-plugin/plugin.json` using the official cachebuster script

- [ ] **Step 1: Update the Chinese operations guide**

Document:

- project discovery uses direct TAPD OpenAPI and needs no third-party CLI/MCP;
- the project selection file path and its non-sensitive fields;
- first selection, re-discovery, manual link/ID fallback and account-switch cleanup;
- Phase 1B remains read-only and work items remain Demo data;
- real validation must not print Token, Authorization, project names, project IDs, response bodies or user nick.

- [ ] **Step 2: Run the complete automated verification**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin
npm run typecheck --workspace @flowrivet/codex-plugin
npm run test:e2e --workspace @flowrivet/codex-plugin
& .\scripts\validate-plugin.ps1 -PluginCreatorRoot "$env:USERPROFILE\.codex\skills\.system\plugin-creator"
```

Expected: every command exits `0`; Vitest and Playwright report no failures.

- [ ] **Step 3: Perform the real TAPD read-only acceptance test**

Restart the built Companion, open a new Codex task, log in through the password field, and run project discovery. Verify only these booleans/count categories in the acceptance note: request succeeded, organization entries excluded, at least one selectable project returned, selection survived Companion restart, and manual known project validation succeeded. Do not capture project identities or Token material.

- [ ] **Step 4: Refresh and reinstall the local plugin**

Run:

```powershell
python "$env:USERPROFILE\.codex\skills\.system\plugin-creator\scripts\update_plugin_cachebuster.py" .
$desktopCodex = Join-Path $env:USERPROFILE ".codex\plugins\.plugin-appserver\codex.exe"
& $desktopCodex plugin add flowrivet@flowrivet-local
```

Expected: `plugin add` reports the new cachebuster version and `plugin list` shows `installed, enabled`.

- [ ] **Step 5: Commit documentation and cache version**

```bash
git add docs/operations/codex-plugin-demo.md .codex-plugin/plugin.json
git commit -m "docs(projects): document project discovery validation"
```

- [ ] **Step 6: Verify the final repository state**

Run: `git status --short && git log -8 --oneline`

Expected: working tree is clean and each implementation unit has its own commit.
