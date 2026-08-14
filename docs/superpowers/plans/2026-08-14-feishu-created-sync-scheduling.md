# Feishu Created-Task Sync Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual Feishu created-task refresh complete, make automatic refresh fairly bounded, and stop missing completion-time fields from failing otherwise valid active tasks.

**Architecture:** Split the change into strict CLI response contracts, a pure fair-rotation scheduler, provider orchestration, provider-neutral cache reconciliation, same-account sync serialization, and UI coverage semantics. Manual refresh scans the full stable type directory; automatic refresh scans at most 40 stable type identities and advances an account-scoped cursor. Full type inventories control pruning independently from the scopes scanned in the current round.

**Tech Stack:** TypeScript 5.9, Node.js 22, Zod 4, React 19, Vitest 3, Playwright, node:sqlite, Meegle CLI 1.0.19.

**Design:** `docs/superpowers/specs/2026-08-14-feishu-created-sync-scheduling-design.md`

---

## File Structure

**Create**

- `packages/codex-plugin/src/meegle/created-sync-scheduler.ts` — pure stable ordering, automatic batch selection, and cursor advancement.
- `packages/codex-plugin/tests/created-sync-scheduler.test.ts` — mutation, wraparound, identity, and fairness tests.
- `packages/codex-plugin/src/cache/merge-work-item-snapshot.ts` — pure provider-neutral in-memory reconciliation used when SQLite writes fail.
- `packages/codex-plugin/tests/merge-work-item-snapshot.test.ts` — differential cache semantics tests.
- `packages/codex-plugin/src/observability/created-sync-diagnostic-logger.ts` — privacy-safe automatic-rotation diagnostics.
- `packages/codex-plugin/tests/created-sync-diagnostic-logger.test.ts` — exact hashing, redaction, and structured-event tests.
- `packages/codex-plugin/tests/work-item-operation-logger.test.ts` — internal cache diagnostics remain logged but absent from public responses.
- `packages/codex-plugin/tests/fixtures/meegle/created-base-query-page.json` — redacted three-field non-empty response.
- `packages/codex-plugin/tests/fixtures/meegle/created-base-query-empty.json` — redacted valid empty response.

**Modify**

- `packages/codex-plugin/src/meegle/meegle-cli-contracts.ts` — separate strict base and completion-enrichment schemas.
- `packages/codex-plugin/src/meegle/meegle-cli-client.ts` — separate three-field base and four-field enrichment methods.
- `packages/codex-plugin/src/meegle/meegle-work-item-provider.ts` — mode-aware type selection, enrichment, inventory, and coverage.
- `packages/codex-plugin/src/server/runtime-services.ts` — inject the created-sync diagnostic logger into the Meegle provider.
- `packages/codex-plugin/src/work-items/work-item-provider.ts` — refresh mode, coverage, and inventory result contracts.
- `packages/codex-plugin/src/cache/work-item-cache-store.ts` — authoritative inventory contract.
- `packages/codex-plugin/src/cache/sqlite-work-item-cache-store.ts` — inventory-driven pruning.
- `packages/codex-plugin/src/work-items/work-item-service.ts` — same-account scheduling, coverage propagation, cache preload, and in-memory fallback.
- `packages/codex-plugin/src/contracts/taskboard.ts` — strict `createdSyncCoverage` union.
- `packages/codex-plugin/src/server/app.ts` — exact tool input/defaulting and snapshot coverage.
- `packages/codex-plugin/src/observability/work-item-operation-logger.ts` — log all internal cache diagnostic codes without exposing them in the taskboard response.
- `packages/codex-plugin/src/notifications/work-item-notification-monitor.ts` — automatic refresh mode.
- `packages/codex-plugin/src/ui/App.tsx` — distinguish manual and timer refresh calls and retain coverage state.
- `packages/codex-plugin/src/ui/use-auto-refresh.ts` — mode-aware same-mode single-flight without swallowing cross-mode requests.
- `packages/codex-plugin/src/ui/components/TaskBoard.tsx` — neutral rotation progress versus true warning copy.
- Corresponding existing tests and fixture README.

Do not modify TAPD provider behavior, write capabilities, execution workflows, or GitLab integration.

---

### Task 1: Split Base and Completion Query Contracts

**Files:**
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-contracts.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-client.ts`
- Modify: `packages/codex-plugin/tests/meegle-cli-client.test.ts`
- Create: `packages/codex-plugin/tests/fixtures/meegle/created-base-query-page.json`
- Create: `packages/codex-plugin/tests/fixtures/meegle/created-base-query-empty.json`
- Modify: `packages/codex-plugin/tests/fixtures/meegle/README.md`

- [ ] **Step 1: Write failing contract tests for three-field base responses**

Add tests that parse a strict row with exactly `work_item_id`, `name`, and `work_item_status`; accept the real `{ data: {}, list: null }` empty shape; and reject missing, duplicate, unknown, over-50, or inconsistent empty structures.

```ts
expect(meegleCreatedBaseQuerySchema.parse(baseFixture).data["1"]).toHaveLength(1);
expect(meegleCreatedBaseQuerySchema.parse(emptyFixture).list).toBeNull();
expect(() => meegleCreatedBaseQuerySchema.parse(inconsistentEmpty)).toThrow();
```

- [ ] **Step 2: Write failing client argv tests**

Require two explicit methods:

```ts
queryCreatedBaseWorkItems(profile, project, type)
queryCreatedCompletionWorkItems(profile, project, type)
```

Assert the base MQL excludes `完成时间`; enrichment includes it. Both must pass a fixed argv array with no shell composition.

- [ ] **Step 3: Run RED tests**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/meegle-cli-client.test.ts
```

Expected: FAIL because the base schema and two client methods do not exist and the current query always selects `完成时间`.

- [ ] **Step 4: Implement minimal strict schemas and client methods**

Keep the existing four-field schema as completion enrichment and add a separate three-field schema. Share only the query envelope helpers; do not weaken `.strict()` or add a catch-all record.

- [ ] **Step 5: Run GREEN tests and typecheck**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/meegle-cli-client.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/codex-plugin/src/meegle/meegle-cli-contracts.ts packages/codex-plugin/src/meegle/meegle-cli-client.ts packages/codex-plugin/tests/meegle-cli-client.test.ts packages/codex-plugin/tests/fixtures/meegle/created-base-query-page.json packages/codex-plugin/tests/fixtures/meegle/created-base-query-empty.json packages/codex-plugin/tests/fixtures/meegle/README.md
git commit -m "fix(meegle): query created tasks without optional fields"
```

---

### Task 2: Add the Pure Fair-Rotation Scheduler

**Files:**
- Create: `packages/codex-plugin/src/meegle/created-sync-scheduler.ts`
- Create: `packages/codex-plugin/tests/created-sync-scheduler.test.ts`

- [ ] **Step 1: Write scheduler RED tests**

Define the wished-for API before implementation:

```ts
const scheduler = new CreatedSyncScheduler({ automaticLimit: 40 });
const batch = scheduler.select({ identityKey, mode: "automatic", types });
scheduler.commit(batch.commitToken);
```

Cover:

- 132 identities produce `40 + 40 + 40 + 12`, then wrap.
- A single 47-type project spans rounds instead of being deferred wholesale.
- Failed attempts still advance after commit.
- No commit on cancellation or identity recheck failure.
- Insert/delete/reorder follows the last attempted stable identity successor.
- Identity change does not reuse a cursor.
- Manual returns every stable identity and does not advance the automatic cursor.
- Two selection attempts cannot commit the same cursor token twice.

- [ ] **Step 2: Run RED test**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/created-sync-scheduler.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement the minimal scheduler**

Use a stable identity string derived from `[projectKey, typeKey]`, sort lexicographically, and store only the last committed identity per account identity key. A selection returns immutable selected entries plus a single-use commit token; commit updates state only after the provider finishes its identity recheck.

- [ ] **Step 4: Run GREEN and mutation boundary tests**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/created-sync-scheduler.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/codex-plugin/src/meegle/created-sync-scheduler.ts packages/codex-plugin/tests/created-sync-scheduler.test.ts
git commit -m "feat(meegle): rotate automatic created-task scans fairly"
```

---

### Task 3: Integrate Mode-Aware Created Queries, Enrichment, Inventory, and Coverage

**Files:**
- Modify: `packages/codex-plugin/src/work-items/work-item-provider.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-work-item-provider.ts`
- Create: `packages/codex-plugin/src/observability/created-sync-diagnostic-logger.ts`
- Modify: `packages/codex-plugin/src/server/runtime-services.ts`
- Modify: `packages/codex-plugin/tests/meegle-work-item-provider.test.ts`
- Create: `packages/codex-plugin/tests/created-sync-diagnostic-logger.test.ts`
- Modify: `packages/codex-plugin/tests/runtime-services.test.ts`

- [ ] **Step 1: Write failing provider tests for refresh modes**

Add `refreshMode?: "manual" | "automatic"` to account-scoped provider input, defaulting internally to manual. Use a generated 132-type fixture to assert manual queries all fixture types while automatic uses the scheduler batch of 40; do not hard-code the real tenant count into production code.

- [ ] **Step 2: Write failing provider tests for enrichment**

Cover zero enrichment calls for active-only base rows; one enrichment call per type containing completed rows; valid completion joins by ID; missing field/command failure/malformed response/duplicate ID/mismatched ID/invalid date/over-50 results retain active rows, drop unverified completed rows, and do not create an error scope. Assert base plus enrichment combined concurrency never exceeds 4.

- [ ] **Step 3: Write failing inventory and coverage tests**

Require result contracts equivalent to:

```ts
authoritativeScopeInventories: [{
  projectExternalId: "P1",
  providerItemTypePrefix: "created:",
  providerItemTypes: ["created:type-a", "created:type-b"],
}]
createdSyncCoverage: {
  catalog: "available",
  mode: "automatic",
  scannedTypeCount: 40,
  totalTypeCount: 132,
  complete: false,
}
```

Cover available, partial, and unavailable directories. Unselected automatic types must produce no error scope. Actual query failures must still produce exact error scopes.

- [ ] **Step 4: Write privacy-safe rotation diagnostic RED tests**

Define `CreatedSyncDiagnosticLogger.completed(event)` and a JSON-stderr implementation. The event contains `mode`, catalog state, total/scanned counts, batch-completed outcome, and `attemptedIdentityHashes`. Hash each stable identity as the first 16 lowercase hexadecimal characters of SHA-256 over `JSON.stringify([projectKey, typeKey])`. Never emit raw project keys, type keys, names, account keys, task data, cursor values, or CLI payloads. Assert deterministic hashing, no raw identifier substrings in serialized output, and runtime injection into `MeegleWorkItemProvider`.

- [ ] **Step 5: Run RED tests**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/meegle-work-item-provider.test.ts tests/created-sync-scheduler.test.ts tests/created-sync-diagnostic-logger.test.ts tests/runtime-services.test.ts
```

Expected: FAIL because the provider still uses the fixed whole-project budget, one four-field query, and scope-derived authority.

- [ ] **Step 6: Implement provider integration**

Replace `maximumCreatedTypeQueriesPerSync` project reservation with scheduler selection. Query base rows first. Queue at most one enrichment operation for each selected type that contains a completed row, through the same four-worker pool. Build inventories from every successful project type directory, independent of selected scopes. Commit the automatic cursor only after the existing post-query profile/user identity verification passes. Emit exactly one redacted diagnostic event after each created-task batch; cancellation or identity mismatch emits `batchCompleted: false` and never advances the cursor.

- [ ] **Step 7: Run GREEN tests and typecheck**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/meegle-work-item-provider.test.ts tests/created-sync-scheduler.test.ts tests/created-sync-diagnostic-logger.test.ts tests/runtime-services.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages/codex-plugin/src/work-items/work-item-provider.ts packages/codex-plugin/src/meegle/meegle-work-item-provider.ts packages/codex-plugin/src/observability/created-sync-diagnostic-logger.ts packages/codex-plugin/src/server/runtime-services.ts packages/codex-plugin/tests/meegle-work-item-provider.test.ts packages/codex-plugin/tests/created-sync-diagnostic-logger.test.ts packages/codex-plugin/tests/runtime-services.test.ts
git commit -m "feat(meegle): support complete and rotating created scans"
```

---

### Task 4: Make Cache Inventory and Fallback Semantics Exact

**Files:**
- Create: `packages/codex-plugin/src/cache/merge-work-item-snapshot.ts`
- Create: `packages/codex-plugin/tests/merge-work-item-snapshot.test.ts`
- Modify: `packages/codex-plugin/src/cache/work-item-cache-store.ts`
- Modify: `packages/codex-plugin/src/cache/sqlite-work-item-cache-store.ts`
- Modify: `packages/codex-plugin/src/work-items/work-item-service.ts`
- Modify: `packages/codex-plugin/tests/sqlite-work-item-cache-store.test.ts`
- Modify: `packages/codex-plugin/tests/work-item-service.test.ts`

- [ ] **Step 1: Write inventory validation and SQLite RED tests**

Cover 40 scanned plus 92 retained types, deleted-type pruning, empty inventory pruning all old created scopes, partial catalog preserving failed-project scopes, duplicate/wrong-prefix inventory rejection, and catalog sentinel replacement. Add `loadAccount(account, now)` tests proving an exact provider/account/tenant match is returned without activating or deleting another account, and a mismatched account returns no snapshot.

- [ ] **Step 2: Write pure fallback RED tests**

The pure merger accepts a previous `CachedSnapshot` plus the same merge input as SQLite. Assert successful live scopes replace cache, failed/unscanned scopes retain cache, inventory deletion remains deleted, source-aware project pruning remains exact, and stable item-key winner semantics retain multi-node items.

- [ ] **Step 3: Write cache failure integration RED tests**

Force SQLite `mergeScopes` to throw after a successful exact-account preload. Cover automatic unscanned retention, manual failed-scope retention, and deleted-type pruning during fallback. Add the account-switch regression: account A is active, account B synchronizes, B's write fails, and no A project/item may appear in B's result.

Lock the cache-failure matrix to these exact public and internal results:

| Exact-account preload | SQLite merge | Returned source | Public `cacheWarningCode` | Internal `cacheDiagnosticCodes` |
|---|---|---|---|---|
| success | success | SQLite merge | absent | `[]` |
| failure | success | SQLite merge | `cache_read_failed` | `["cache_read_failed"]` |
| success | failure | pure cache/live merge | `cache_write_failed` | `["cache_write_failed"]` |
| failure | failure | live-only | `cache_write_failed` | `["cache_read_failed", "cache_write_failed"]` |

`cacheDiagnosticCodes` is an ordered, internal-only field on `WorkItemSyncSnapshot`. `buildProviderTaskboardSnapshot()` must not place it inside the strict public taskboard contract; Task 5 carries it beside the public snapshot in a request-local envelope and logs both codes through `WorkItemOperationLogger`, so the secondary read failure remains diagnosable without expanding the public API.

- [ ] **Step 4: Run RED tests**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/merge-work-item-snapshot.test.ts tests/sqlite-work-item-cache-store.test.ts tests/work-item-service.test.ts
```

Expected: FAIL because inventory authority and preloaded in-memory reconciliation do not exist.

- [ ] **Step 5: Implement pure reconciliation and SQLite inventory pruning**

Validate every inventory as unique full values matching its prefix. Make SQLite and the pure merger consume the same normalized inventory helper so their pruning rules cannot drift. Do not derive retained types from current scopes. Extend `WorkItemCacheStore` with `loadAccount(account, now)`; implement it as an exact provider/account/tenant lookup that has no activation or deletion side effects. Keep `loadActive(providerId, now)` only for disconnected/startup display paths.

- [ ] **Step 6: Preload cache for both modes and use fallback merger**

Before live synchronization, call `loadAccount(input.cacheAccount, attemptedAt)` when cache identity exists; never call `loadActive()` for an authenticated sync. On write failure, reconcile the live result with that exact-account snapshot in memory. Apply the failure matrix above exactly: write failure wins the single public warning, while the ordered internal diagnostic list retains both failures. If preload and write both fail, return live-only and never consult another active account.

- [ ] **Step 7: Run GREEN and differential tests**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/merge-work-item-snapshot.test.ts tests/sqlite-work-item-cache-store.test.ts tests/work-item-service.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages/codex-plugin/src/cache/merge-work-item-snapshot.ts packages/codex-plugin/tests/merge-work-item-snapshot.test.ts packages/codex-plugin/src/cache/work-item-cache-store.ts packages/codex-plugin/src/cache/sqlite-work-item-cache-store.ts packages/codex-plugin/src/work-items/work-item-service.ts packages/codex-plugin/tests/sqlite-work-item-cache-store.test.ts packages/codex-plugin/tests/work-item-service.test.ts
git commit -m "fix(cache): preserve unscanned created-task scopes"
```

---

### Task 5: Serialize Same-Account Modes and Expose Exact Tool Contracts

**Files:**
- Modify: `packages/codex-plugin/src/work-items/work-item-service.ts`
- Modify: `packages/codex-plugin/src/contracts/taskboard.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/src/observability/work-item-operation-logger.ts`
- Modify: `packages/codex-plugin/src/notifications/work-item-notification-monitor.ts`
- Modify: `packages/codex-plugin/tests/work-item-service.test.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`
- Modify: `packages/codex-plugin/tests/work-item-notification-monitor.test.ts`
- Modify: `packages/codex-plugin/tests/contracts.test.ts`
- Create: `packages/codex-plugin/tests/work-item-operation-logger.test.ts`

- [ ] **Step 1: Write same-account coordination RED tests**

Assert two automatic calls coalesce and advance once; two manual calls coalesce; automatic during manual reuses the full manual result without advancing; manual during automatic waits and then runs once; different accounts remain independent; query concurrency remains bounded at 4.

- [ ] **Step 2: Write strict coverage contract RED tests**

Add the discriminated `available | partial | unavailable` coverage union and cross-field refinements from the design. Reject impossible counts and `complete` mismatches.

- [ ] **Step 3: Write server and notification RED tests**

Require:

- open/list always call manual.
- refresh defaults to manual.
- refresh accepts only `{ refreshMode: "manual" | "automatic" }`.
- invalid/unknown fields are rejected.
- notification monitor passes automatic.
- when exact-account cache preload and merge both fail, the public response contains only `cacheWarningCode: "cache_write_failed"`, while the completed operation event contains ordered `cacheDiagnosticCodes: ["cache_read_failed", "cache_write_failed"]`; the strict taskboard schema rejects `cacheDiagnosticCodes` if accidentally exposed.
- two concurrent tool calls with different diagnostic arrays log only their own values. No module variable, mutable closure, async-local global, or request-ID lookup table may carry diagnostics between the builder and logger.

Use this request-local internal contract:

```ts
interface WorkItemToolRunResult {
  snapshot: TaskboardSnapshot;
  cacheDiagnosticCodes: Array<"cache_read_failed" | "cache_write_failed">;
}
```

Both taskboard builders return a new envelope per invocation. The provider builder copies the internal codes from its own `WorkItemSyncSnapshot`; TAPD, disconnected, and offline paths return `[]` unless their own request encountered one of those cache failures. `registerWorkItemTool()` parses and returns only `result.snapshot`, but passes `result.cacheDiagnosticCodes` into that request's `WorkItemOperationEvent`.

- [ ] **Step 4: Run RED tests**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/work-item-service.test.ts tests/server.test.ts tests/work-item-notification-monitor.test.ts tests/contracts.test.ts tests/work-item-operation-logger.test.ts
```

Expected: FAIL because the current tools have `{}` inputs and WorkItemService only has one unqualified in-flight map.

- [ ] **Step 5: Implement same-account scheduling and contract propagation**

Use an account-keyed coordinator with mode-aware coalescing and serialization. Include refresh mode in provider input but not as an excuse to run cross-mode operations concurrently. Propagate `createdSyncCoverage` without synthesizing it for TAPD. Implement the request-local `WorkItemToolRunResult` envelope above. Extend only the internal operation event with ordered `cacheDiagnosticCodes`; `registerWorkItemTool()` returns the strict `snapshot` member as structured content, and taskboard serialization remains an explicit allowlist. Never use shared mutable state to bridge diagnostics into logging.

- [ ] **Step 6: Run GREEN tests and typecheck**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/work-item-service.test.ts tests/server.test.ts tests/work-item-notification-monitor.test.ts tests/contracts.test.ts tests/work-item-operation-logger.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/codex-plugin/src/work-items/work-item-service.ts packages/codex-plugin/src/contracts/taskboard.ts packages/codex-plugin/src/server/app.ts packages/codex-plugin/src/observability/work-item-operation-logger.ts packages/codex-plugin/src/notifications/work-item-notification-monitor.ts packages/codex-plugin/tests/work-item-service.test.ts packages/codex-plugin/tests/server.test.ts packages/codex-plugin/tests/work-item-notification-monitor.test.ts packages/codex-plugin/tests/contracts.test.ts packages/codex-plugin/tests/work-item-operation-logger.test.ts
git commit -m "feat(sync): distinguish manual and automatic refreshes"
```

---

### Task 6: Render Rotation Progress Without Hiding Real Failures

**Files:**
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/use-auto-refresh.ts`
- Modify: `packages/codex-plugin/src/ui/components/TaskBoard.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`
- Modify: `packages/codex-plugin/tests/use-auto-refresh.test.tsx`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`

- [ ] **Step 1: Write UI RED tests for mode calls**

Change the hook contract to `performRefresh(mode)` and `requestRefresh(mode = "manual")`. Assert opening and the toolbar call manual while the timer calls automatic. Keep one in-flight promise per mode: repeated manual calls reuse manual and repeated timer calls reuse automatic, but cross-mode requests are both forwarded to `WorkItemService`. Add both overlap cases: automatic in flight then manual click, and manual in flight then timer tick. `pending` stays true until all in-flight mode promises settle, and timer rescheduling happens only after the automatic promise settles.

- [ ] **Step 2: Write coverage-state RED tests**

Cover:

- automatic incomplete with no actual errors: neutral progress, no degradation warning.
- automatic incomplete plus query errors: progress and warning both visible.
- partial catalog: known progress plus directory warning.
- manual complete: full-scan success copy.
- unavailable/offline/cache error: existing warning semantics remain.

Use `role="status"` for neutral progress and `role="alert"` for actual failures. Do not rely on color alone.

- [ ] **Step 3: Run RED tests**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx tests/use-auto-refresh.test.tsx
```

Expected: FAIL because the UI sends `{}` for both refresh paths and has no coverage rendering.

- [ ] **Step 4: Implement minimal UI behavior**

Pass mode explicitly from the timer callback and toolbar handler. Make `useAutoRefresh` coalesce only same-mode calls; it must never satisfy a manual request with an automatic promise or suppress the backend queueing rules from Task 5. Store coverage from each snapshot. Suppress only the mixed-data warning caused solely by expected rotation; never suppress actual failed projects, unavailable catalog, offline state, rate limits, or cache warnings.

- [ ] **Step 5: Run component and Playwright tests**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx tests/use-auto-refresh.test.tsx
npm run test:e2e --workspace @flowrivet/codex-plugin
```

Expected: PASS, including manual refresh, automatic progress, and warning accessibility cases.

- [ ] **Step 6: Commit**

```powershell
git add packages/codex-plugin/src/ui/App.tsx packages/codex-plugin/src/ui/use-auto-refresh.ts packages/codex-plugin/src/ui/components/TaskBoard.tsx packages/codex-plugin/src/ui/styles.css packages/codex-plugin/tests/ui.test.tsx packages/codex-plugin/tests/use-auto-refresh.test.tsx packages/codex-plugin/e2e/taskboard.spec.ts
git commit -m "feat(ui): show created-task scan coverage"
```

---

### Task 7: Full Verification and Real Feishu Acceptance

**Files:**
- Modify only if behavior changed: `docs/user-guide.md`
- Modify with redacted results: `docs/abf-poc/2026-08-14-feishu-created-sync-results.md`

- [ ] **Step 1: Run the complete automated verification**

```powershell
npm test --workspace @flowrivet/codex-plugin
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
npm run test:e2e --workspace @flowrivet/codex-plugin
git diff --check
```

Expected: all commands exit 0; only explicitly documented platform skips are allowed.

- [ ] **Step 2: Update the local plugin and Companion**

```powershell
npm run plugin:update -- --json
```

Expected: `ok: true`, a healthy Companion instance, and no rollback.

- [ ] **Step 3: Run real manual acceptance**

In one running Companion session and one unchanged authenticated profile, invoke the FlowRivet MCP tool exactly once with:

```json
{"refreshMode":"manual"}
```

Record only non-sensitive summary evidence:

- directory coverage equals current full total.
- `需求测试-TEST` / `7073686987` is present.
- projects formerly skipped by the 40-query project budget are actually queried.
- missing completion-time metadata does not create base type failures.
- remaining failures, if any, have a distinct real provider cause.

- [ ] **Step 4: Run real automatic rotation acceptance**

Without restarting Companion, changing profile, or running a manual refresh between rounds, invoke `refresh_my_work_items` four times sequentially with this exact input, waiting for each response before the next:

```json
{"refreshMode":"automatic"}
```

Capture the four `created_sync.completed` JSON stderr events from the same process. Verify:

- coverage is `40, 40, 40, 12` for the observed 132-type catalog, or the corresponding `40...remainder` sequence if the live catalog changed.
- every event has `batchCompleted: true` and the same available catalog count.
- before the first wrap, `attemptedIdentityHashes` are pairwise disjoint and their union size equals `totalTypeCount`.
- recomputing SHA-256 from the local in-memory test directory is allowed only during the acceptance process; the POC stores counts and PASS/FAIL, not raw keys or the full hash sets.
- unscanned cached items remain visible and no deferred type/project increments failure counts.

If catalog count changes between rounds, discard the run and repeat from a fresh Companion process so the fairness assertion is not ambiguous.

- [ ] **Step 5: Document redacted results**

Write `docs/abf-poc/2026-08-14-feishu-created-sync-results.md` with environment versions, counts, duration, coverage sequence, PASS/FAIL, and any residual limitations. Do not include task bodies, people, tokens, cookies, emails, or raw CLI payloads.

- [ ] **Step 6: Run final diff-scoped review and commit**

```powershell
git add docs/abf-poc/2026-08-14-feishu-created-sync-results.md docs/user-guide.md
git commit -m "docs(meegle): record created-task sync acceptance"
```

- [ ] **Step 7: Push the branch**

```powershell
git push origin codex/feishu-project-provider
```

Expected: all task commits are present on `origin/codex/feishu-project-provider` and the worktree is clean.
