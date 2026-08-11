# FlowRivet Feishu Project Meegle Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Feishu Project provider backed only by the official Meegle CLI, make it the default for new users, and let users switch between Feishu Project and TAPD while preserving provider-isolated auth, cache, and task data.

**Architecture:** Add a process-level provider registry with optional project/detail capabilities, split work-item querying into project-scoped and account-scoped modes, and implement `feishu-project` as an account-scoped adapter over a bounded Meegle CLI client. Keep TAPD on its existing project-scoped adapters, move runtime composition out of request-scoped MCP server creation, and make the React UI consume provider-neutral connection contracts.

**Tech Stack:** TypeScript 5.9, Node.js 22 `child_process`, Zod 4, MCP SDK/MCP Apps, React 19, Vitest, Testing Library, Playwright, official `@lark-project/meegle` CLI

**Source Spec:** `docs/superpowers/specs/2026-08-11-feishu-project-meegle-provider-design.md`

---

## File Map

New provider-neutral files:

- `packages/codex-plugin/src/contracts/providers.ts`: public provider, connection, login transaction, active selection, and stable error schemas.
- `packages/codex-plugin/src/providers/provider-registry.ts`: registered provider capabilities and lookup.
- `packages/codex-plugin/src/providers/active-provider-store.ts`: persistence interface and errors.
- `packages/codex-plugin/src/providers/json-active-provider-store.ts`: atomic cross-platform active-provider persistence.
- `packages/codex-plugin/src/providers/provider-auth-service.ts`: provider-neutral read/disconnect contract plus optional interactive login capability.
- `packages/codex-plugin/src/server/runtime-services.ts`: process-level provider registry, synchronizers, auth transactions, stores, and factories.

New Meegle files:

- `packages/codex-plugin/src/meegle/command-runner.ts`: bounded, injectable, cross-platform subprocess execution.
- `packages/codex-plugin/src/meegle/meegle-cli-contracts.ts`: schemas verified by the CLI probe.
- `packages/codex-plugin/src/meegle/meegle-cli-client.ts`: fixed public commands, version/status/profile/user/task page API, and error mapping.
- `packages/codex-plugin/src/meegle/meegle-auth-service.ts`: connection state, device login transaction, identity binding, cancel, and logout.
- `packages/codex-plugin/src/meegle/meegle-work-item-provider.ts`: pagination, deduplication, normalization, status mapping, and seven-day completion filtering.

New UI files:

- `packages/codex-plugin/src/ui/components/ProviderSwitcher.tsx`: accessible single-provider selection.
- `packages/codex-plugin/src/ui/components/FeishuProjectLogin.tsx`: CLI missing, disconnected, authorizing, connected, expired, and unavailable states.

Existing files with focused changes:

- `packages/codex-plugin/src/work-items/work-item-provider.ts`: discriminated project/account query modes.
- `packages/codex-plugin/src/work-items/work-item-service.ts`: common cache pipeline with two fresh-scope fetch strategies.
- `packages/codex-plugin/src/work-items/tapd-work-item-provider.ts`: declare `project_scoped` mode only.
- `packages/codex-plugin/src/contracts/projects.ts`: reuse provider-neutral connection schema and capability error.
- `packages/codex-plugin/src/contracts/taskboard.ts`: replace TAPD-specific connection envelope.
- `packages/codex-plugin/src/server/app.ts`: register provider-neutral tools and build snapshot from active registration.
- `packages/codex-plugin/src/server/taskboard-runtime.ts`: create runtime services once and inject per MCP Server.
- `packages/codex-plugin/src/ui/App.tsx`: provider-neutral load, switch, auth, refresh, and external-link fallback.
- `packages/codex-plugin/src/ui/components/ConnectionMenu.tsx`: provider selector and active connection actions.
- `packages/codex-plugin/src/ui/components/AppHeader.tsx`: active provider label and state.
- `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`: provider-aware accessible label.
- `packages/codex-plugin/src/ui/demo-harness.tsx`: provider-neutral demo tool responses.
- `packages/codex-plugin/src/ui/styles.css`: compact provider/auth states with existing visual language.
- `skills/my-work-taskboard/SKILL.md`: provider-neutral FlowRivet routing for Feishu Project and TAPD.
- `skills/my-tapd-taskboard/SKILL.md`: retain an explicit TAPD compatibility route for this release.
- `docs/operations/codex-plugin-demo.md`: Meegle installation, login, switch, and acceptance steps.

---

### Task 1: Probe The Official CLI And Freeze Synthetic Contracts

**Files:**
- Create: `packages/codex-plugin/tests/fixtures/meegle/auth-status-connected.json`
- Create: `packages/codex-plugin/tests/fixtures/meegle/user-me.json`
- Create: `packages/codex-plugin/tests/fixtures/meegle/mywork-this-week-page.json`
- Create: `packages/codex-plugin/tests/fixtures/meegle/mywork-overdue-page.json`
- Create: `packages/codex-plugin/tests/fixtures/meegle/mywork-done-page.json`
- Create: `docs/abf-poc/2026-08-11-meegle-cli-probe.md`
- Modify if assumptions fail: `docs/superpowers/specs/2026-08-11-feishu-project-meegle-provider-design.md`
- Modify if assumptions fail: `docs/superpowers/plans/2026-08-11-feishu-project-meegle-provider.md`

- [x] **Step 1: Verify installation and public command metadata without writing credentials**

Run:

```powershell
npx -y @lark-project/meegle@latest install
meegle --version
meegle config set host project.feishu.cn
meegle inspect mywork.todo
meegle auth status --format json
```

Expected: CLI version is printed; `mywork.todo` exposes `action` and `page_num`; unauthenticated status returns structured JSON and a documented nonzero exit rather than hanging.

- [x] **Step 2: Complete user OAuth only if status is disconnected**

Run in a real terminal:

```powershell
meegle auth login --device-code --host project.feishu.cn
meegle auth status --format json
meegle user me --format json
```

Expected: the user completes authorization in the browser or phone; status reports `authenticated: true`; user output contains stable account identity fields. Never paste credentials into chat or a file.

- [x] **Step 3: Inspect all selected scopes and pagination behavior**

Run each page in the terminal and inspect without redirecting raw output to the repo:

```powershell
meegle mywork todo --action this_week --page-num 1 --format json
meegle mywork todo --action overdue --page-num 1 --format json
meegle mywork todo --action done --page-num 1 --format json
```

Expected: each response preserves `list` and `total`; `list` may be `null`. Determine the 50-item page size, null/short-page termination rule, stable work-item/project/type/status fields, completion-time field, and whether `done` is newest-first.

- [x] **Step 4: Write synthetic fixtures, never copied production values**

Use stable fake values such as `PROJ`, `10001`, `Example requirement`, and `user_example`. Preserve only field names, nesting, scalar types, and documented enum shapes. Assert manually that none of the following appears in the staged diff: real user name, project name/key, work-item ID/title, tenant, URL, device code, token, stdout, or stderr.

- [x] **Step 5: Record the gate result**

Document CLI version, executable form on Windows, auth JSON shape, login event shape, pagination contract, done ordering/filter support, required enrichment calls, and structured errors. If the probe contradicts authentication, pagination, or required-field assumptions, update the design spec and obtain approval before Task 2.

- [x] **Step 6: Verify and commit the evidence**

Run:

```powershell
rg -n "Bearer [A-Za-z0-9]|MEEGLE_USER_ACCESS_TOKEN=|wuchenjie|吴晨杰" packages/codex-plugin/tests/fixtures/meegle docs/abf-poc/2026-08-11-meegle-cli-probe.md
git diff --check
```

Expected: no secret or real identity match; diff check passes.

Commit:

```text
docs(meegle): record verified CLI contracts
```

---

### Task 2: Add Provider Contracts, Registry, And Default Selection

**Files:**
- Create: `packages/codex-plugin/src/contracts/providers.ts`
- Create: `packages/codex-plugin/src/providers/provider-registry.ts`
- Create: `packages/codex-plugin/src/providers/active-provider-store.ts`
- Create: `packages/codex-plugin/src/providers/json-active-provider-store.ts`
- Create: `packages/codex-plugin/tests/provider-registry.test.ts`
- Create: `packages/codex-plugin/tests/active-provider-store.test.ts`
- Modify: `packages/codex-plugin/src/contracts/projects.ts`
- Modify: `packages/codex-plugin/src/contracts/taskboard.ts`
- Modify: `packages/codex-plugin/tests/contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Cover:

```ts
expect(activeProviderSchema.parse({ version: 1, activeProviderId: "feishu-project" }))
  .toEqual({ version: 1, activeProviderId: "feishu-project" });
expect(providerConnectionSchema.parse({
  providerId: "feishu-project",
  displayName: "飞书项目",
  state: "cli_missing",
})).toBeTruthy();
```

Also assert that taskboard snapshots contain `connection.provider`, not `connection.tapd`, and reject credentials, executable paths, CLI arguments, tokens, authorization URLs, and device codes outside the ephemeral login-result schema. Add migration cases: no active-provider file plus no legacy TAPD credential defaults to Feishu; no file plus an existing encrypted TAPD credential writes and returns TAPD; subsequent reads honor the saved value even if the legacy credential later disappears.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts provider-registry.test.ts active-provider-store.test.ts
```

Expected: FAIL because provider contracts and stores do not exist.

- [ ] **Step 3: Implement the provider-neutral schemas and registry**

Use these core shapes:

```ts
export type ProviderConnectionState =
  | "checking" | "cli_missing" | "disconnected" | "authorizing"
  | "connected" | "expired" | "unavailable";

export interface ProviderRegistration {
  id: string;
  displayName: string;
  loginMode: "personal_token" | "device_code";
  auth: ProviderAuthService;
  workItems: WorkItemProvider;
  projects?: ProjectCatalog;
  details?: WorkItemDetailReader;
}
```

`ProviderRegistry.get(id)` throws `provider_not_registered`; `list()` returns only non-sensitive descriptors and connection states.

- [ ] **Step 4: Implement atomic active-provider persistence**

Follow `JsonTaskboardPreferencesStore`: resolve the existing FlowRivet config directory, write a temporary file, and atomically rename. Let the runtime migration service supply an optional legacy default: missing file plus existing TAPD credential writes `tapd`; missing file without that signal writes `feishu-project`. Preserve any registered saved choice and return a warning plus Feishu fallback for unknown IDs. Do not overwrite malformed files.

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts provider-registry.test.ts active-provider-store.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 6: Commit**

Commit:

```text
feat(provider): persist the active project system
```

---

### Task 3: Support Account-Scoped Work-Item Synchronization

**Files:**
- Modify: `packages/codex-plugin/src/work-items/work-item-provider.ts`
- Modify: `packages/codex-plugin/src/work-items/work-item-service.ts`
- Modify: `packages/codex-plugin/src/work-items/tapd-work-item-provider.ts`
- Modify: `packages/codex-plugin/tests/work-item-service.test.ts`
- Modify: `packages/codex-plugin/tests/tapd-work-item-provider.test.ts`
- Modify if required by project aggregation: `packages/codex-plugin/src/cache/work-item-cache-store.ts`
- Modify if required by project aggregation: `packages/codex-plugin/src/cache/sqlite-work-item-cache-store.ts`
- Modify if required by project aggregation: `packages/codex-plugin/tests/sqlite-work-item-cache-store.test.ts`

- [ ] **Step 1: Write a failing account-scoped synchronization test**

Create a fake provider with `queryMode: "account_scoped"`. Call `sync()` with an empty project list and assert:

```ts
expect(provider.listAccountWorkItems).toHaveBeenCalledTimes(1);
expect(snapshot.projects).toEqual([
  expect.objectContaining({ providerId: "feishu-project", externalId: "PROJ", count: 1 }),
]);
expect(snapshot.items[0]?.projectExternalId).toBe("PROJ");
```

Also test partial scope failure, no usable scope, provider/account/profile singleflight isolation, and cache merge without prior project discovery.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- work-item-service.test.ts
```

Expected: FAIL because only project-scoped providers exist.

- [ ] **Step 3: Add the discriminated provider modes**

Define `ProjectScopedWorkItemProvider` and `AccountScopedWorkItemProvider`. Account results must include `projects` plus scopes carrying `projectExternalId`. Keep provider-specific response fields outside the shared interfaces.

- [ ] **Step 4: Refactor only the fresh-scope acquisition path**

Extract private methods in `WorkItemService`:

```ts
private fetchProjectScoped(input: WorkItemSyncInput): Promise<FreshSyncResult>
private fetchAccountScoped(input: WorkItemSyncInput): Promise<FreshSyncResult>
```

Feed both into the existing cache merge, freshness, seven-day completion, sort, failure priority, and retry-after code. For account mode, use result projects rather than `input.projects`. Add a non-persisted `syncSessionKey` to `WorkItemSyncInput`; Meegle supplies the captured Profile while TAPD omits it. Preserve a single process-level in-flight key containing provider, account, tenant, `syncSessionKey`, and the applicable project set. Never persist Profile in SQLite.

- [ ] **Step 5: Declare TAPD project mode and run regressions**

Add `readonly queryMode = "project_scoped" as const` to `TapdWorkItemProvider` without changing its HTTP behavior.

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- work-item-service.test.ts tapd-work-item-provider.test.ts sqlite-work-item-cache-store.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS, including all existing TAPD tests.

- [ ] **Step 6: Commit**

Commit:

```text
refactor(sync): support account-scoped providers
```

---

### Task 4: Build A Bounded Cross-Platform Meegle CLI Client

**Files:**
- Create: `packages/codex-plugin/src/meegle/command-runner.ts`
- Create: `packages/codex-plugin/src/meegle/meegle-cli-contracts.ts`
- Create: `packages/codex-plugin/src/meegle/meegle-cli-client.ts`
- Create: `packages/codex-plugin/tests/command-runner.test.ts`
- Create: `packages/codex-plugin/tests/meegle-cli-client.test.ts`

- [ ] **Step 1: Write failing runner tests**

Use injected fake child processes to assert executable-not-found, `.cmd` resolution, fixed argument arrays, timeout, abort, process-tree termination, stdout/stderr 10 MiB limits, nonzero exit, JSON parse failure, and no command/stdout/stderr content in thrown messages.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- command-runner.test.ts meegle-cli-client.test.ts
```

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement executable resolution and bounded execution**

Use `spawn` with `shell: false` for native executables. Resolve an npm `.cmd` shim to an absolute trusted path before invoking `cmd.exe /d /s /c`; use a dedicated Windows quoting function and only fixed internal business arguments. Capture stdout/stderr in bounded buffers, but expose stderr only as a classified error code.

- [ ] **Step 4: Implement fixed public commands**

Expose only:

```ts
getVersion()
getCurrentProfile()
getAuthStatus(profile?)
getCurrentUser(profile)
startDeviceLogin(host, signal, onEvent)
logout(profile)
getMyWorkPage(profile, action, pageNum)
```

Every JSON command appends `--format json`; business commands append the captured `--profile`. `getCurrentProfile()` parses the bounded single-line text emitted by `config profile current`, because `1.0.19` does not honor JSON format for that command. Validate all other responses against Task 1 schemas. Map missing CLI, unsupported version, auth exit 1, server exit 2, timeout, output limit, invalid JSON, and unknown failures to stable provider errors.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- command-runner.test.ts meegle-cli-client.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS on Windows; platform branches are covered with injected `platform` and PATH resolvers.

- [ ] **Step 6: Commit**

Commit:

```text
feat(meegle): add a bounded CLI client
```

---

### Task 5: Add Meegle Connection And Login Transactions

**Files:**
- Create: `packages/codex-plugin/src/providers/provider-auth-service.ts`
- Create: `packages/codex-plugin/src/meegle/meegle-auth-service.ts`
- Create: `packages/codex-plugin/tests/meegle-auth-service.test.ts`
- Modify: `packages/codex-plugin/src/auth/tapd-auth-service.ts`
- Modify: `packages/codex-plugin/tests/tapd-auth-service.test.ts`

- [ ] **Step 1: Write failing authentication-state tests**

Cover CLI missing, no local token, rejected token, server unreachable, connected identity, one in-flight login per Profile, duplicate start reuse, cancel, five-minute timeout, logout confirmation boundary, Profile change, and identity change between pre/post checks.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- meegle-auth-service.test.ts tapd-auth-service.test.ts
```

Expected: FAIL because generic auth and Meegle service are absent.

- [ ] **Step 3: Implement connection inspection**

Call version, current Profile, auth status, then user identity. Return `cli_missing`, `disconnected`, `expired`, `unavailable`, or `connected` without reading CLI config/keychain files. Store only profile name plus stable account/tenant keys in memory for synchronization identity.

- [ ] **Step 4: Implement device login transaction management**

If Task 1 proved stable structured login events, return ephemeral `{ transactionId, verificationUri, userCode, expiresAt }`; otherwise return `{ transactionId, manualCommand, expiresAt }` and poll `auth status`. Do not expose raw CLI output. Reuse a current transaction, support explicit cancel, and retain successful CLI credentials because the official CLI owns them.

- [ ] **Step 5: Adapt TAPD to the provider auth read/disconnect subset**

Keep `login_with_tapd_token` as a compatibility write path. Add an adapter or methods so the registry can read TAPD connection and disconnect it through the same provider capability without making a generic tool accept arbitrary credentials.

- [ ] **Step 6: Run tests and commit**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- meegle-auth-service.test.ts tapd-auth-service.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

Commit:

```text
feat(meegle): manage user-owned CLI sessions
```

---

### Task 6: Normalize Meegle Personal Work Into The Shared Board

**Files:**
- Create: `packages/codex-plugin/src/meegle/meegle-work-item-provider.ts`
- Create: `packages/codex-plugin/tests/meegle-work-item-provider.test.ts`
- Modify only if enrichment is proven necessary: `packages/codex-plugin/src/meegle/meegle-cli-client.ts`
- Modify: `packages/codex-plugin/tests/fixtures/meegle/*.json`

- [ ] **Step 1: Write fixture-driven failing tests**

Test all Task 1 response envelopes plus empty pages, exact page boundary, duplicated this-week/overdue items, partial page failure, invalid stable IDs, unknown type/status, invalid URL/date, seven-day completion boundary, missing completion time, 1,000-page/50,000-item limits, Profile pinning, and pre/post identity mismatch.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- meegle-work-item-provider.test.ts
```

Expected: FAIL because the provider is absent.

- [ ] **Step 3: Implement account-scoped pagination**

Declare `queryMode: "account_scoped"`. Fetch `this_week`, `overdue`, and `done` with concurrency 2. Treat `list: null` as empty, fetch 50-item pages until a null/short page, and cross-check accumulated count with `total`; never infer success from page 1 alone. Fully paginate `done` within hard safety limits, then filter the seven-day window locally.

- [ ] **Step 4: Normalize and deduplicate**

Build keys as:

```ts
`feishu-project:${projectKey}:${typeKey}:${workItemId}`
```

Merge duplicate active records by completeness, preserve overdue state, map stable type keys to requirement/task/defect/other, map stable state metadata to four stages, and keep unknown active states in `todo`. Preserve only HTTPS URLs on the configured Feishu Project host; when the CLI omits a URL, leave `externalUrl` absent and keep the card read-only.

- [ ] **Step 5: Add enrichment only when Task 1 requires it**

The verified list provides the card's identity, title, project, type, status/node, and completion time. It omits URL, and `workitem get` does not add one, so omit enrichment in the first release and allow `externalUrl` to be absent. Add batch enrichment later only for a newly required field with a verified CLI contract.

- [ ] **Step 6: Verify provider and common cache behavior**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- meegle-work-item-provider.test.ts work-item-service.test.ts sqlite-work-item-cache-store.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 7: Commit**

Commit:

```text
feat(meegle): sync personal project work
```

---

### Task 7: Compose Providers Once And Expose Provider-Neutral MCP Tools

**Files:**
- Create: `packages/codex-plugin/src/server/runtime-services.ts`
- Modify: `packages/codex-plugin/src/server/taskboard-runtime.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/src/server/http.ts`
- Modify: `packages/codex-plugin/src/observability/project-operation-logger.ts`
- Modify: `packages/codex-plugin/src/observability/work-item-operation-logger.ts`
- Modify: `packages/codex-plugin/tests/taskboard-runtime.test.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: Write failing runtime-lifetime and tool-contract tests**

Assert that repeated HTTP request servers share one registry, active store, Meegle auth transaction manager, TAPD synchronizer, and Meegle synchronizer. Assert the tool list contains `list_providers`, `get_active_provider`, `set_active_provider`, `get_provider_connection`, `start_provider_login`, `cancel_provider_login`, and `disconnect_provider`, while TAPD compatibility tools remain.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- taskboard-runtime.test.ts server.test.ts
```

Expected: FAIL because runtime services and tools do not exist.

- [ ] **Step 3: Build process-level runtime services**

Move default credential stores, provider adapters, catalogs, synchronizers, preference store, and active-provider store into `createDefaultRuntimeServices()`. Instantiate once in `createTaskboardRuntime()` and inject into each request-scoped `createTaskboardMcpServer()`.

- [ ] **Step 4: Build the active-provider snapshot flow**

For `project_scoped` TAPD: retain discovery then sync. For `account_scoped` Feishu: skip project discovery, call account sync, and derive `projectCatalog.projects` from synchronized projects. On disconnected/error states, load only the active provider cache. Never fall through to TAPD auth, project catalog, or detail service for Feishu.

- [ ] **Step 5: Register provider-neutral tools and compatibility aliases**

Validate registered IDs, reject arbitrary executable/Profile/host/args, keep login transaction instructions ephemeral, and clear only the disconnected provider cache. Rename resource/tool titles from “我的 TAPD 待办” to “我的待办” while preserving tool names `open_my_taskboard`, `list_my_work_items`, and `refresh_my_work_items`.

- [ ] **Step 6: Verify logs are content-free**

Tests must serialize every success/error event and reject authorization URL/code, Profile contents, account/project/item data, command args, stdout, and stderr. Keep requestId, providerId, command category, outcome, duration, page/item counts, and stable error only.

- [ ] **Step 7: Run server regressions and commit**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- taskboard-runtime.test.ts server.test.ts contracts.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

Commit:

```text
feat(plugin): route tools through the active provider
```

---

### Task 8: Add Provider Switching And Feishu Login UI

**Files:**
- Create: `packages/codex-plugin/src/ui/components/ProviderSwitcher.tsx`
- Create: `packages/codex-plugin/src/ui/components/FeishuProjectLogin.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/ConnectionMenu.tsx`
- Modify: `packages/codex-plugin/src/ui/components/AppHeader.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`
- Modify: `packages/codex-plugin/tests/bridge.test.ts`

- [ ] **Step 1: Write failing interaction tests**

Cover default Feishu provider, preserved TAPD provider, keyboard provider selection, switch loading, CLI missing/install copy/recheck, disconnected/start login, authorizing URL/code/manual-command fallback, cancel, connected identity, expired reconnect, unavailable cache, logout confirmation, live-region announcements, focus movement, non-color errors, and no token/raw CLI output in the DOM.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx bridge.test.ts
```

Expected: FAIL because the UI is TAPD-specific.

- [ ] **Step 3: Implement the provider-neutral app state**

Replace `connection.tapd` branches with `connection.provider`. On switch, call `set_active_provider`, show target cached snapshot, then call `open_my_taskboard`. Ignore stale switch/auth/detail responses using the existing request-generation pattern. Keep automatic refresh bound to the active provider snapshot.

- [ ] **Step 4: Implement compact connection surfaces**

Use a radio/menu selection inside the existing connection menu. Reuse `TapdLogin` for TAPD. Add `FeishuProjectLogin` states without nested cards. Copy/install/recheck and authorization controls use Lucide icons where available, stable dimensions, keyboard names, and tooltips for unfamiliar icons.

- [ ] **Step 5: Implement Feishu card-open fallback**

When the active registration has no detail capability, clicking a fresh or cached Feishu card opens its validated HTTPS external URL in a new window with `noopener,noreferrer`; it must not call `get_work_item_detail`. TAPD continues to use the existing detail drawer.

- [ ] **Step 6: Run component tests, build UI, and commit**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx bridge.test.ts
npm run build:ui --workspace @flowrivet/codex-plugin
```

Expected: PASS; Vite produces a single nonempty app bundle.

Commit:

```text
feat(taskboard): switch between Feishu Project and TAPD
```

---

### Task 9: Update Plugin Routing, Operations, And End-To-End Coverage

**Files:**
- Create: `skills/my-work-taskboard/SKILL.md`
- Create: `skills/my-work-taskboard/agents/openai.yaml`
- Modify: `skills/my-tapd-taskboard/SKILL.md`
- Modify: `skills/my-tapd-taskboard/agents/openai.yaml`
- Modify: `.codex-plugin/plugin.json` only if display metadata is TAPD-specific
- Modify: `docs/operations/codex-plugin-demo.md`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `tests/codex-plugin-docs.test.ts`
- Modify: `tests/plugin-package.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing package/docs/E2E assertions**

Assert the skill routes generic “打开我的待办看板” and explicit 飞书项目/TAPD requests, never asks for a Meegle token, and explains CLI installation/login. Add Playwright cases for default Feishu, provider switch, CLI missing, auth states, cross-provider board rendering, overflow, and keyboard focus.

- [ ] **Step 2: Update user-facing routing and operations docs**

Create the provider-neutral `my-work-taskboard` skill and keep `my-tapd-taskboard` as a deprecated but valid explicit TAPD compatibility skill; directory names and frontmatter names must continue to match. Document:

```powershell
npx -y @lark-project/meegle@latest install
meegle config set host project.feishu.cn
meegle auth login --device-code
meegle auth status --format json
```

Explain that credentials stay with the official CLI/system keychain, Feishu is the new-user default, existing TAPD selection is preserved, and the official Feishu Project MCP is not required.

- [ ] **Step 3: Run the full automated verification suite**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
npm test
npm run typecheck
npm run build
npm run test:e2e --workspace @flowrivet/codex-plugin
```

Expected: all tests, typechecks, builds, and Playwright scenarios pass.

- [ ] **Step 4: Run the real Windows read-only acceptance test**

Start the Companion, rebuild/reinstall the local plugin, open a new Codex task, connect the current Meegle Profile, and compare de-identified counts for `this_week`, `overdue`, and seven-day `done` against direct CLI commands. Switch TAPD -> Feishu -> TAPD and verify login/cache isolation. Exercise offline and rejected-token states without recording user/project/item content.

- [ ] **Step 5: Inspect the final diff for secrets and generated churn**

Run:

```powershell
git diff --check
git status --short
rg -n "Bearer |MEEGLE_USER_ACCESS_TOKEN|verificationUri|userCode" packages docs skills README.md
```

Expected: only contract/test references to sensitive field names; no secret values, raw probe output, unrelated generated files, or `node_modules` changes.

- [ ] **Step 6: Commit**

Commit:

```text
docs(plugin): document the Feishu Project workflow
```

---

## Final Review And Completion

- [ ] Run `compound-engineering:ce-code-review` against this plan and the complete diff.
- [ ] Fix all correctness, security, contract, and test findings; rerun affected checks.
- [ ] Run `superpowers:verification-before-completion` and capture fresh command evidence.
- [ ] Run `compound-engineering:ce-compound` and record the verified Meegle CLI integration lessons under `docs/solutions/`.
- [ ] Confirm `git status --short --branch` contains no uncommitted task changes.
- [ ] Push only after the user requests or confirms publishing.
