# Configurable Taskboard Auto Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral, locally persisted refresh preference and refresh open FlowRivet boards at the configured interval without polling while hidden, violating an opt-out, or multiplying TAPD requests across open boards.

**Architecture:** A versioned JSON Store and small preference service expose global settings through two local MCP tools. A focused React hook owns visibility-aware scheduling and UI single-flight, while a Companion process runtime shares one `WorkItemSynchronizer` across request-scoped MCP servers. TAPD `429` responses propagate a provider-neutral cooldown to the UI.

**Tech Stack:** TypeScript 5.9, Node.js 22.5+, Zod 4, React 19, MCP Apps SDK, Vitest, Testing Library, Playwright

**Origin:** `docs/superpowers/specs/2026-08-10-taskboard-auto-refresh-design.md`

---

## File Map

### New files

- `packages/codex-plugin/src/contracts/taskboard-preferences.ts`: provider-neutral preference schemas and public types.
- `packages/codex-plugin/src/preferences/taskboard-preferences-store.ts`: Store interface and stable storage errors.
- `packages/codex-plugin/src/preferences/json-taskboard-preferences-store.ts`: versioned, atomic cross-platform JSON persistence.
- `packages/codex-plugin/src/preferences/taskboard-preferences-service.ts`: default/read/save behavior independent of MCP.
- `packages/codex-plugin/src/observability/taskboard-preferences-operation-logger.ts`: redacted preference tool logging.
- `packages/codex-plugin/src/server/taskboard-runtime.ts`: process-lifetime shared dependencies for request-scoped MCP servers.
- `packages/codex-plugin/src/ui/use-auto-refresh.ts`: visibility-aware timer, single-flight, and rate-limit cooldown.
- `packages/codex-plugin/src/ui/components/AutoRefreshSettings.tsx`: preset menu items and accessible custom-seconds dialog.
- `packages/codex-plugin/tests/taskboard-preferences.test.ts`: schema, Store, and service tests.
- `packages/codex-plugin/tests/taskboard-runtime.test.ts`: process-level synchronizer reuse tests.

### Existing files to modify

- `packages/codex-plugin/src/contracts/taskboard.ts`: rate-limit reason and optional cooldown metadata.
- `packages/codex-plugin/src/work-items/work-item-provider.ts`: provider-neutral rate-limit error metadata.
- `packages/codex-plugin/src/work-items/tapd-work-item-provider.ts`: parse TAPD `429` and `Retry-After`.
- `packages/codex-plugin/src/work-items/work-item-service.ts`: aggregate rate-limit reasons, maximum cooldown, and identity-scoped single-flight.
- `packages/codex-plugin/src/server/app.ts`: inject preferences, register tools, and expose a default synchronizer factory.
- `packages/codex-plugin/src/server/http.ts`: create one runtime per Companion process.
- `packages/codex-plugin/src/ui/App.tsx`: load/save preferences and route all refreshes through the hook.
- `packages/codex-plugin/src/ui/components/AppHeader.tsx`: consume coordinator pending state without changing layout.
- `packages/codex-plugin/src/ui/components/ConnectionMenu.tsx`: render the auto-refresh menu group.
- `packages/codex-plugin/src/ui/styles.css`: bounded menu/dialog styling and responsive rules.
- `packages/codex-plugin/src/ui/demo-harness.tsx`: deterministic preference and automatic-refresh scenarios.
- `packages/codex-plugin/tests/contracts.test.ts`: public schema coverage.
- `packages/codex-plugin/tests/tapd-work-item-provider.test.ts`: `429` mapping and request-stop coverage.
- `packages/codex-plugin/tests/work-item-service.test.ts`: cooldown aggregation and failure precedence.
- `packages/codex-plugin/tests/server.test.ts`: preference tools, annotations, errors, and logs.
- `packages/codex-plugin/tests/ui.test.tsx`: fake-timer, visibility, settings, focus, and reconnection coverage.
- `packages/codex-plugin/e2e/taskboard.spec.ts`: desktop/mobile settings and automatic-refresh journeys.
- `docs/operations/codex-plugin-demo.md`: configuration paths, behavior, and acceptance steps.

---

### Task 1: Define and persist provider-neutral taskboard preferences

**Files:**
- Create: `packages/codex-plugin/src/contracts/taskboard-preferences.ts`
- Create: `packages/codex-plugin/src/preferences/taskboard-preferences-store.ts`
- Create: `packages/codex-plugin/src/preferences/json-taskboard-preferences-store.ts`
- Create: `packages/codex-plugin/src/preferences/taskboard-preferences-service.ts`
- Create: `packages/codex-plugin/tests/taskboard-preferences.test.ts`
- Modify: `packages/codex-plugin/tests/contracts.test.ts`

- [ ] **Step 1: Write failing schema and Store tests**

Test the exact accepted values and persistence envelope:

```ts
expect(taskboardPreferencesSchema.parse({ refreshIntervalSeconds: 0 }))
  .toEqual({ refreshIntervalSeconds: 0 });
expect(taskboardPreferencesSchema.parse({ refreshIntervalSeconds: 5 }))
  .toEqual({ refreshIntervalSeconds: 5 });
expect(() => taskboardPreferencesSchema.parse({ refreshIntervalSeconds: 4 }))
  .toThrow();
expect(() => taskboardPreferencesSchema.parse({ refreshIntervalSeconds: 5.5 }))
  .toThrow();
expect(() => taskboardPreferencesSchema.parse({ refreshIntervalSeconds: 3601 }))
  .toThrow();
```

Cover missing file -> 60 seconds, saved `0`, saved custom boundary values, a second Store instance reading the same value, corrupt JSON, unknown version, read failure, atomic rename failure preserving the old file, and temporary-file cleanup.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/taskboard-preferences.test.ts tests/contracts.test.ts
```

Expected: FAIL because the preference contract and Store do not exist.

- [ ] **Step 3: Implement the contract and Store boundary**

Use an exact union/refinement instead of accepting arbitrary numbers:

```ts
export const refreshIntervalSecondsSchema = z.number().int().refine(
  (value) => value === 0 || (value >= 5 && value <= 3600),
  "refresh interval must be 0 or an integer from 5 to 3600 seconds",
);

export const taskboardPreferencesSchema = z.object({
  refreshIntervalSeconds: refreshIntervalSecondsSchema,
}).strict();

export const defaultTaskboardPreferences = {
  refreshIntervalSeconds: 60,
} as const;
```

Define `TaskboardPreferencesStore.load/save`, `TaskboardPreferencesStoreError`, and a version-1 envelope. Reuse `resolveFlowRivetConfigDirectory()` and the existing atomic temporary-file pattern, but keep this file independent from project selections and `flowrivet.db`.

- [ ] **Step 4: Implement service semantics**

`TaskboardPreferencesService.get()` returns the Store result. A missing file is handled inside the JSON Store as the default; corrupt/unsupported/I/O failures remain `taskboard_preferences_read_failed`. `save()` validates before writing and returns the confirmed saved value.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/taskboard-preferences.test.ts tests/contracts.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/codex-plugin/src/contracts/taskboard-preferences.ts packages/codex-plugin/src/preferences/taskboard-preferences-store.ts packages/codex-plugin/src/preferences/json-taskboard-preferences-store.ts packages/codex-plugin/src/preferences/taskboard-preferences-service.ts packages/codex-plugin/tests/taskboard-preferences.test.ts packages/codex-plugin/tests/contracts.test.ts
git commit -m "feat(taskboard): persist auto refresh preferences"
```

---

### Task 2: Expose local preference tools with redacted logging

**Files:**
- Create: `packages/codex-plugin/src/observability/taskboard-preferences-operation-logger.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: Write failing MCP contract tests**

Assert that:

- `get_taskboard_preferences` is read-only, closed-world, and has no UI resource.
- `save_taskboard_preferences` is non-destructive, idempotent, closed-world, and accepts only `refreshIntervalSeconds`.
- get returns the default or saved value.
- save returns the confirmed Store value and never calls a work-item Provider.
- invalid input maps to `taskboard_preferences_invalid`.
- read/write failures expose stable codes without paths or file contents.
- logs contain only requestId, tool, outcome, duration, error code, and interval seconds.

- [ ] **Step 2: Run server tests and verify failure**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/server.test.ts
```

Expected: FAIL because the tools are not registered.

- [ ] **Step 3: Add injectable preference dependencies**

Extend `TaskboardMcpServerOptions` with a narrow reader/writer interface and logger. Default to `TaskboardPreferencesService(new JsonTaskboardPreferencesStore(...))`.

Register both tools with these annotations:

```ts
get:  { readOnlyHint: true,  openWorldHint: false }
save: { readOnlyHint: false, destructiveHint: false,
        idempotentHint: true, openWorldHint: false }
```

Return `structuredContent` validated by `taskboardPreferencesSchema`. Do not include the setting in the initial taskboard snapshot; the UI loads preferences after bridge initialization so preference failure cannot invalidate board rendering.

- [ ] **Step 4: Add stable errors and logging**

Map schema failures to `taskboard_preferences_invalid`, Store reads to `taskboard_preferences_read_failed`, and Store writes to `taskboard_preferences_write_failed`. Log only the approved metadata; do not log exception messages from filesystem operations.

- [ ] **Step 5: Run server tests and typecheck**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/server.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/codex-plugin/src/observability/taskboard-preferences-operation-logger.ts packages/codex-plugin/src/server/app.ts packages/codex-plugin/tests/server.test.ts
git commit -m "feat(plugin): expose taskboard refresh preferences"
```

---

### Task 3: Propagate TAPD rate-limit cooldowns

**Files:**
- Modify: `packages/codex-plugin/src/contracts/taskboard.ts`
- Modify: `packages/codex-plugin/src/work-items/work-item-provider.ts`
- Modify: `packages/codex-plugin/src/work-items/tapd-work-item-provider.ts`
- Modify: `packages/codex-plugin/src/work-items/work-item-service.ts`
- Modify: `packages/codex-plugin/tests/contracts.test.ts`
- Modify: `packages/codex-plugin/tests/tapd-work-item-provider.test.ts`
- Modify: `packages/codex-plugin/tests/work-item-service.test.ts`

- [ ] **Step 1: Write failing Adapter tests**

Cover `Retry-After` integer seconds, HTTP dates using an injected clock, missing/invalid values -> 60, lower/upper bounds `1` and `86400`, and values outside the bounds -> 60. Assert the first `429` marks the current and remaining type scopes as `provider_rate_limited` without issuing more requests for that project.

- [ ] **Step 2: Write failing aggregation tests**

Test that `WorkItemService`:

- uses failure precedence `provider_unauthorized` > `provider_rate_limited` > `provider_unavailable` > `work_item_sync_failed`;
- takes the maximum valid cooldown across projects/scopes;
- returns `retryAfterSeconds` only with `provider_rate_limited`;
- preserves mixed/offline cached scopes while exposing the cooldown;
- throws the stable rate-limit error when no usable scope exists.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/tapd-work-item-provider.test.ts tests/work-item-service.test.ts tests/contracts.test.ts
```

Expected: FAIL because rate-limit metadata is not in the provider or taskboard contracts.

- [ ] **Step 4: Implement provider-neutral metadata**

Extend the error/scope shapes:

```ts
export type WorkItemErrorCode =
  | "work_item_sync_failed"
  | "provider_unauthorized"
  | "provider_rate_limited"
  | "provider_unavailable";

interface RateLimitMetadata {
  retryAfterSeconds?: number;
}
```

Add optional `retryAfterSeconds` to failed scopes, `WorkItemProviderError`, `WorkItemSyncSnapshot`, and `taskboardSnapshotSchema`. Enforce the cross-field condition in service construction and tests: cooldown metadata is emitted only for the rate-limit reason.

- [ ] **Step 5: Parse TAPD 429 safely**

Parse delta-seconds and HTTP-date forms relative to the injected clock. Clamp accepted durations to `1～86400`; invalid/out-of-range values become 60. Once a project request receives `429`, synthesize failed results for its remaining item types instead of calling TAPD again.

- [ ] **Step 6: Aggregate cooldown and rerun tests**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/tapd-work-item-provider.test.ts tests/work-item-service.test.ts tests/contracts.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/codex-plugin/src/contracts/taskboard.ts packages/codex-plugin/src/work-items/work-item-provider.ts packages/codex-plugin/src/work-items/tapd-work-item-provider.ts packages/codex-plugin/src/work-items/work-item-service.ts packages/codex-plugin/tests/contracts.test.ts packages/codex-plugin/tests/tapd-work-item-provider.test.ts packages/codex-plugin/tests/work-item-service.test.ts
git commit -m "feat(taskboard): respect provider rate limits"
```

---

### Task 4: Share synchronization across request-scoped MCP servers

**Files:**
- Create: `packages/codex-plugin/src/server/taskboard-runtime.ts`
- Create: `packages/codex-plugin/tests/taskboard-runtime.test.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/src/server/http.ts`

- [ ] **Step 1: Write a failing runtime identity test**

Use injected factories to create two request-scoped MCP servers and capture their options. Assert the default work-item synchronizer factory runs once and both servers receive the exact same object reference. Also assert an explicitly injected synchronizer is preserved.

```ts
const runtime = createTaskboardRuntime(options, {
  createWorkItemSynchronizer: () => shared,
  createMcpServer: (captured) => captured,
});
expect(runtime.createServer().workItemService).toBe(shared);
expect(runtime.createServer().workItemService).toBe(shared);
```

- [ ] **Step 2: Write failing keyed concurrent synchronization tests**

Through two runtime-created servers or a narrow synchronizer harness, start two refreshes before resolving the Provider. Assert that requests with the same provider, stable account key, tenant key, and sorted available-project ID set make one Provider synchronization and receive the same result.

Then assert that changing the account key, tenant key, or project ID set never reuses the in-flight Promise. A request without a stable account key must not join a cross-request in-flight operation. Do not assert against display names: they are mutable and are not identity boundaries. These tests must fail against both per-request `WorkItemService` construction and the current unkeyed `WorkItemService.inFlight` field.

- [ ] **Step 3: Run the runtime tests and verify failure**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/taskboard-runtime.test.ts
```

Expected: FAIL because no process runtime exists.

- [ ] **Step 4: Implement the runtime factory and keyed single-flight**

Move only default work-item synchronizer construction behind an exported factory. `createTaskboardRuntime()` creates or accepts one synchronizer at Companion startup and returns `createServer()`, which injects the shared reference into each `createTaskboardMcpServer()` call. Keep MCP Server and Transport request-scoped.

Replace the single optional `WorkItemService.inFlight` Promise with an in-memory map keyed by `providerId + accountKey + tenantKey + sorted available project IDs`. Remove each entry in `finally`. Never persist or log the key. When `cacheAccount.accountKey` is missing, execute without joining or publishing an in-flight entry. This preserves process-level deduplication without allowing account, tenant, or project results to cross boundaries.

Update `createTaskboardHttpServer()` to construct the runtime once, outside the HTTP request callback:

```ts
const runtime = createTaskboardRuntime(options);
return createServer(async (request, response) => {
  const server = runtime.createServer();
  // existing request-scoped transport lifecycle
});
```

- [ ] **Step 5: Run runtime/server tests and typecheck**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/taskboard-runtime.test.ts tests/server.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/codex-plugin/src/server/taskboard-runtime.ts packages/codex-plugin/src/server/app.ts packages/codex-plugin/src/server/http.ts packages/codex-plugin/tests/taskboard-runtime.test.ts packages/codex-plugin/tests/server.test.ts
git commit -m "fix(plugin): share work item synchronization"
```

---

### Task 5: Add visibility-aware refresh coordination and settings UI

**Files:**
- Create: `packages/codex-plugin/src/ui/use-auto-refresh.ts`
- Create: `packages/codex-plugin/src/ui/components/AutoRefreshSettings.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/AppHeader.tsx`
- Modify: `packages/codex-plugin/src/ui/components/ConnectionMenu.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: Write failing preference UI tests**

Test initial `get_taskboard_preferences`, preset selection, custom dialog values `5` and `3600`, rejection of blank/fraction/4/3601, save pending, save failure preserving the prior setting, custom display copy, Escape, focus trap, and focus restoration. A preference read failure must set this session to `0` and show a non-blocking warning.

- [ ] **Step 2: Write failing fake-timer tests**

Using `vi.useFakeTimers()` and a controllable bridge, cover:

- default 60 seconds and each preset;
- `0` produces no automatic call;
- manual refresh resets the next automatic deadline;
- repeated manual/automatic triggers share one Promise;
- hidden pages clear the timer;
- visible pages refresh immediately only when elapsed time reached the interval;
- ordinary failure waits one configured interval;
- `provider_rate_limited` waits `max(configured interval, retryAfterSeconds)`;
- a thrown `provider_rate_limited` error without cooldown metadata waits `max(configured interval, 60)`;
- disconnected/expired pauses, reconnect completion resets the anchor and resumes;
- unmount removes timer and `visibilitychange` listener.

- [ ] **Step 3: Run UI tests and verify failure**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx
```

Expected: FAIL because preferences and automatic scheduling are absent.

- [ ] **Step 4: Implement the focused refresh hook**

`useAutoRefresh()` owns refs for interval, last completion (`performance.now()`), rate-limit deadline, timer, mounted state, and in-flight Promise. It returns `requestRefresh`, `markAttemptCompleted`, and `pending`. React state is used only for rendered pending status; timer correctness must not depend on asynchronous state updates.

The hook accepts `enabled`, `intervalSeconds | undefined`, and `performRefresh`. `undefined` means preferences are still loading and must not schedule. It listens to Page Visibility API, uses remaining-time scheduling rather than setInterval, and always re-reads the latest refs before scheduling.

- [ ] **Step 5: Implement settings components and App integration**

Load preferences after bridge initialization. Render preset choices as accessible radio-style menu commands with visible checkmarks. Keep the custom dialog separate from `ConnectionMenu` so the menu remains compact. Use the same native-dialog focus pattern as reconnect/detail.

Route the header button and timer through `requestRefresh`; successful login/open calls `markAttemptCompleted`. Apply returned `retryAfterSeconds` to scheduling. On preferences read failure use `0`, not 60. Saving does not trigger a TAPD refresh and only changes scheduling after confirmed success.

- [ ] **Step 6: Run UI tests, typecheck, and UI build**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build:ui --workspace @flowrivet/codex-plugin
```

Expected: PASS; `dist/ui/taskboard.html` remains a single bundle.

- [ ] **Step 7: Commit**

```powershell
git add packages/codex-plugin/src/ui/use-auto-refresh.ts packages/codex-plugin/src/ui/components/AutoRefreshSettings.tsx packages/codex-plugin/src/ui/App.tsx packages/codex-plugin/src/ui/components/AppHeader.tsx packages/codex-plugin/src/ui/components/ConnectionMenu.tsx packages/codex-plugin/src/ui/styles.css packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(taskboard): schedule configurable auto refresh"
```

---

### Task 6: Add browser acceptance and operational guidance

**Files:**
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `docs/operations/codex-plugin-demo.md`
- Modify: `tests/codex-plugin-docs.test.ts`

- [ ] **Step 1: Add failing deterministic browser journeys**

Extend the Harness to answer preference tools, persist the in-memory selected interval for the page, count refresh calls, and expose the count in an accessible test status. Add Playwright journeys for:

- selecting no refresh and a preset;
- saving a custom interval;
- advancing the browser clock by 5 seconds and observing exactly one refresh;
- opening/closing the custom dialog with keyboard focus restoration;
- desktop and 390px mobile menu/dialog without outer horizontal overflow.

- [ ] **Step 2: Run E2E and verify failure**

Run:

```powershell
npm run test:e2e --workspace @flowrivet/codex-plugin
```

Expected: new journeys FAIL before Harness/UI support is complete.

- [ ] **Step 3: Complete Harness and browser behavior**

Use Playwright Clock to advance the iframe timer without a real five-second sleep. Keep all data synthetic. Do not expose a test-only production tool or reduce the contract minimum below five seconds.

- [ ] **Step 4: Update Chinese operations documentation**

Document:

- global preference paths on Windows/macOS/Linux;
- default, presets, custom range, and “不刷新” behavior;
- hidden/visible timing and manual-refresh reset;
- rate-limit cooldown and Token-expired pause;
- multiple open boards sharing one Companion synchronization;
- preference read/write failure recovery;
- confirmation that automatic refresh is read-only and stops when no board is open.

Extend the docs contract test to require those statements and continue rejecting embedded credential values.

- [ ] **Step 5: Run full verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e --workspace @flowrivet/codex-plugin
```

Expected: all suites PASS.

- [ ] **Step 6: Inspect package and diff**

Run:

```powershell
npm pack --dry-run --json --workspace @flowrivet/codex-plugin
git diff --check
git status --short
```

Expected: runtime output contains the new contracts/runtime/UI; no preference file, database, Token, test result, or user data is packaged; no whitespace errors or unrelated changes exist.

- [ ] **Step 7: Commit**

```powershell
git add packages/codex-plugin/src/ui/demo-harness.tsx packages/codex-plugin/e2e/taskboard.spec.ts docs/operations/codex-plugin-demo.md tests/codex-plugin-docs.test.ts
git commit -m "test(taskboard): verify configurable auto refresh"
```

---

## Completion Gate

- [ ] Every task has a focused commit and the worktree is clean.
- [ ] Default 60, off, all presets, and custom 5～3600 seconds are covered.
- [ ] Missing preference file defaults to 60; read failure disables automatic refresh for the session.
- [ ] Hidden pages do not start requests; visible pages use the exact remaining interval.
- [ ] Manual, automatic, visibility, and multiple-board triggers with the same sync identity do not multiply Provider calls in one Companion process.
- [ ] Different accounts, tenants, or project sets never share an in-flight Promise or result.
- [ ] HTTP `429` stops the remaining project requests and cools down automatic refresh.
- [ ] Disconnected/expired pauses; successful reconnect refreshes once and resumes.
- [ ] Existing live/mixed/offline cards remain available after refresh failures.
- [ ] Preference files and logs contain no credentials or business data.
- [ ] No server background scheduler, push channel, TAPD write tool, drag behavior, or detail persistence was introduced.
- [ ] Unit, contract, typecheck, build, Playwright, package, and diff checks pass.
