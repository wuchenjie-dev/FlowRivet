# Work Item Cache And Offline Degradation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist provider-neutral work-item summaries in a local SQLite database so FlowRivet can restore a clearly marked mixed or offline board for seven days without caching credentials or details.

**Architecture:** TAPD returns an explicit result for every `(project, provider item type)` scope. `WorkItemService` merges successful live scopes with unexpired cached scopes through a provider-neutral `WorkItemCacheStore`; the MCP orchestrator falls back to the active cache when authentication or the provider is unavailable. A lazy SQLite adapter keeps online reads usable if `node:sqlite` cannot initialize, while internal stable identity keys remain separate from public MCP connection data.

**Tech Stack:** TypeScript 5.9, Node.js 22.5+ `node:sqlite`, Zod 4, MCP Apps SDK, React 19, Vitest, Testing Library, Playwright.

**Origin:** `docs/superpowers/specs/2026-08-10-work-item-cache-offline-design.md`

---

## File Map

- Create `packages/codex-plugin/src/cache/work-item-cache-store.ts`: provider-neutral cache types, errors, and store contract.
- Create `packages/codex-plugin/src/cache/sqlite-work-item-cache-store.ts`: schema v1, transactions, scope merge, expiry, validation, and deletion.
- Create `packages/codex-plugin/src/cache/create-work-item-cache-store.ts`: lazy `node:sqlite` capability detection and unavailable fallback.
- Create `packages/codex-plugin/tests/sqlite-work-item-cache-store.test.ts`: SQLite contract, retention, isolation, corruption, and permissions tests.
- Modify `packages/codex-plugin/src/auth/tapd-identity-client.ts`: retain internal stable `id`/`nick` separately from display name.
- Modify `packages/codex-plugin/src/auth/tapd-auth-service.ts`: expose validated internal sessions and candidate/commit login phases.
- Modify `packages/codex-plugin/src/contracts/auth.ts`: add cache/login error codes without exposing stable identity values.
- Modify `packages/codex-plugin/src/contracts/taskboard.ts`: add item freshness and snapshot cache metadata.
- Modify `packages/codex-plugin/src/work-items/work-item-provider.ts`: replace `items + failedKinds` with explicit scope outcomes.
- Modify `packages/codex-plugin/src/work-items/tapd-work-item-provider.ts`: return `story`, `task`, and `bug` scope outcomes independently.
- Modify `packages/codex-plugin/src/work-items/work-item-service.ts`: merge live/cache scopes, filter, sort, and retain in-flight deduplication.
- Modify `packages/codex-plugin/src/server/app.ts`: wire cache, offline fallback, two-phase login, disconnect ordering, and logging metadata.
- Modify `packages/codex-plugin/src/observability/work-item-operation-logger.ts`: log only freshness counts/outcomes and stable error codes.
- Modify `packages/codex-plugin/src/ui/App.tsx`: render cached boards even when TAPD is expired/disconnected and host reconnect dialog state.
- Modify `packages/codex-plugin/src/ui/components/TaskBoard.tsx`: render mixed/offline banner and reconnect action.
- Modify `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`: render a fixed-size cached marker.
- Modify `packages/codex-plugin/src/ui/components/TapdLogin.tsx`: support dialog mode and remove stale Phase 1A copy.
- Modify `packages/codex-plugin/src/ui/styles.css`: responsive/accessibility styles for freshness states.
- Modify existing provider, service, auth, contract, server, UI, and E2E tests beside the corresponding production files.
- Create `packages/codex-plugin/scripts/probe-work-item-cache.mjs`: redacted real read-only restart probe using a temporary database.
- Modify `packages/codex-plugin/package.json`, root `package.json`, and `package-lock.json`: Node engine floor and probe script.
- Modify `docs/operations/codex-plugin-demo.md`: cache location, retention, reconnect, and safe probe instructions.

### Task 1: Define Freshness Contracts And Stable Internal Identity

**Files:**
- Modify: `package.json`
- Modify: `packages/codex-plugin/package.json`
- Modify: `package-lock.json`
- Modify: `packages/codex-plugin/src/contracts/auth.ts`
- Modify: `packages/codex-plugin/src/contracts/taskboard.ts`
- Modify: `packages/codex-plugin/src/auth/tapd-identity-client.ts`
- Modify: `packages/codex-plugin/src/demo/fixtures.ts`
- Modify: `packages/codex-plugin/src/work-items/tapd-work-item-provider.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Test: `packages/codex-plugin/tests/contracts.test.ts`
- Test: `packages/codex-plugin/tests/tapd-auth-service.test.ts`
- Test: `packages/codex-plugin/tests/work-item-service.test.ts`
- Test: `packages/codex-plugin/tests/server.test.ts`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [x] **Step 1: Write failing contract and identity tests**

Add assertions that `workItemSchema` requires `freshness`, `taskboardSnapshotSchema` accepts `live/mixed/offline` metadata, and parsed public auth output does not expose stable identity fields. Extend identity fixtures to assert `accountKey` uses TAPD `id`, falls back to `nick`, and name-only responses produce no stable key.

```ts
expect(client.validate("personal-token")).resolves.toMatchObject({
  userName: "吴晨杰",
  accountKey: "6081",
  companyId: "66238498",
});
const publicResult = authResultSchema.parse({
  ok: true,
  connection: { tapd: "connected", userName: "吴晨杰", accountKey: "6081" },
});
expect(publicResult.connection).not.toHaveProperty("accountKey");
```

- [x] **Step 2: Run focused tests and verify failure**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/contracts.test.ts tests/tapd-auth-service.test.ts`

Expected: FAIL because freshness metadata and `TapdIdentity.accountKey` do not exist.

- [x] **Step 3: Implement the contract changes**

Add these provider-neutral fields:

```ts
freshness: z.enum(["fresh", "cached"])
dataFreshness: z.enum(["live", "mixed", "offline"])
staleScopeCount: z.number().int().nonnegative()
lastSuccessfulSyncAt: z.string().optional()
lastSyncAttemptAt: z.string()
cacheWarningCode: z.enum([
  "cache_unavailable",
  "cache_identity_unavailable",
  "cache_read_failed",
  "cache_write_failed",
]).optional()
freshnessReasonCode: z.enum([
  "provider_unauthorized",
  "provider_unavailable",
  "work_item_sync_failed",
]).optional()
```

Extend only the internal TAPD identity with `accountKey?: string`, parsed from `id` then `nick`. Keep stable identity fields out of public `AuthResult`; add only `cache_clear_failed` and `selection_store_failed` operational error codes. Update every existing production/test work-item creator with `freshness: "fresh"` and every existing snapshot creator with `dataFreshness: "live"`, zero stale scopes, and aligned sync timestamps. Set both root and plugin Node engines to `>=22.5`, then run `npm install --package-lock-only` to refresh lockfile metadata.

- [x] **Step 4: Run focused tests and typecheck**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/contracts.test.ts tests/tapd-auth-service.test.ts`

Expected: PASS.

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS after every typed fixture is updated.

Run: `npm test --workspace @flowrivet/codex-plugin`

Expected: PASS so the contract migration does not leave later tasks on a broken baseline.

- [x] **Step 5: Commit**

```bash
git add package.json packages/codex-plugin/package.json package-lock.json packages/codex-plugin/src/contracts/auth.ts packages/codex-plugin/src/contracts/taskboard.ts packages/codex-plugin/src/auth/tapd-identity-client.ts packages/codex-plugin/src/demo/fixtures.ts packages/codex-plugin/src/work-items/tapd-work-item-provider.ts packages/codex-plugin/src/server/app.ts packages/codex-plugin/tests/contracts.test.ts packages/codex-plugin/tests/tapd-auth-service.test.ts packages/codex-plugin/tests/work-item-service.test.ts packages/codex-plugin/tests/server.test.ts packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(taskboard): define cached snapshot contracts"
```

### Task 2: Return Explicit Provider Scope Outcomes

**Files:**
- Modify: `packages/codex-plugin/src/work-items/work-item-provider.ts`
- Modify: `packages/codex-plugin/src/work-items/tapd-work-item-provider.ts`
- Test: `packages/codex-plugin/tests/tapd-work-item-provider.test.ts`
- Test: `packages/codex-plugin/tests/work-item-service.test.ts`

- [x] **Step 1: Replace test fixtures with explicit scope results**

Tests must require exactly three TAPD results and verify an empty successful scope is distinguishable from an error:

```ts
expect(result.scopes).toEqual([
  { providerItemType: "story", kind: "requirement", outcome: "success", items: [] },
  { providerItemType: "task", kind: "task", outcome: "error", items: [], errorCode: "work_item_sync_failed" },
  { providerItemType: "bug", kind: "defect", outcome: "success", items: [] },
]);
```

- [x] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/tapd-work-item-provider.test.ts tests/work-item-service.test.ts`

Expected: FAIL because the provider still returns `items` and `failedKinds`.

- [x] **Step 3: Implement the provider-neutral result contract**

```ts
export interface WorkItemScopeResult {
  providerItemType: string;
  kind: WorkItemKind;
  outcome: "success" | "error";
  items: WorkItem[];
  errorCode?: WorkItemErrorCode;
}

export interface WorkItemQueryResult {
  projectExternalId: string;
  scopes: WorkItemScopeResult[];
}
```

Extend `WorkItemErrorCode` with `provider_unavailable`. TAPD maps each API call to one result. A 401/403 returns `provider_unauthorized` for the affected and remaining scopes; transport failures return `provider_unavailable`, while invalid provider payloads return `work_item_sync_failed`. Never omit a configured scope.

- [x] **Step 4: Run provider tests and typecheck**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/tapd-work-item-provider.test.ts tests/work-item-service.test.ts`

Expected: PASS with temporary service fixtures adapted to explicit scopes.

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/codex-plugin/src/work-items/work-item-provider.ts packages/codex-plugin/src/work-items/tapd-work-item-provider.ts packages/codex-plugin/tests/tapd-work-item-provider.test.ts packages/codex-plugin/tests/work-item-service.test.ts
git commit -m "refactor(taskboard): expose provider sync scopes"
```

### Task 3: Implement The SQLite Cache Store

**Files:**
- Create: `packages/codex-plugin/src/cache/work-item-cache-store.ts`
- Create: `packages/codex-plugin/src/cache/sqlite-work-item-cache-store.ts`
- Create: `packages/codex-plugin/src/cache/create-work-item-cache-store.ts`
- Create: `packages/codex-plugin/tests/sqlite-work-item-cache-store.test.ts`

- [ ] **Step 1: Write failing store contract tests against temporary databases**

Cover initial/repeated schema creation, scope replacement, successful empty scope, failed-scope retention, account/provider isolation, partial unique active account constraint, seven-day per-scope expiry, orphan cleanup, transaction rollback, malformed JSON, unknown schema versions, and `clearActive`. Inject `now` and database path; never open the user's real config database.

```ts
await store.mergeScopes({ account, projects: [project], scopes: [freshTaskScope], now });
await store.mergeScopes({ account, projects: [project], scopes: [failedTaskScope], now: later });
expect((await store.loadActive("tapd", later))?.items).toEqual([
  expect.objectContaining({ externalId: "1", freshness: "cached" }),
]);
```

- [ ] **Step 2: Run the store tests and verify failure**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/sqlite-work-item-cache-store.test.ts`

Expected: FAIL because cache modules do not exist.

- [ ] **Step 3: Define the provider-neutral cache port**

```ts
export interface CacheAccount {
  providerId: string;
  accountKey: string;
  tenantKey?: string;
  accountDisplayName: string;
  tenantDisplayName?: string;
}

export interface WorkItemCacheStore {
  activateAccount(input: CacheAccount): Promise<void>;
  mergeScopes(input: CacheMergeInput): Promise<CachedSnapshot>;
  loadActive(providerId: string, now: Date): Promise<CachedSnapshot | undefined>;
  clearActive(providerId: string): Promise<void>;
  purgeExpired(now: Date): Promise<number>;
}
```

Define stable `WorkItemCacheError` codes and a persisted-item schema derived from `workItemSchema.omit({ freshness: true })`.

- [ ] **Step 4: Implement schema v1 and transactional operations**

Use bound parameters, `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = DELETE`, a `schema_version` table, four cache tables from the spec, and:

```sql
CREATE UNIQUE INDEX one_active_cache_account_per_provider
ON cache_accounts(provider_id)
WHERE is_active = 1;
```

Compute `namespace_key` with SHA-256 over length-delimited `providerId`, tenant key, and account key. Expire `cache_scopes` individually only when `last_success_at < now - 7 days`; the exact seven-day boundary remains valid. Cascade items, remove orphan projects, then remove empty accounts. Strip `freshness` before writing and add `cached` after reading.

- [ ] **Step 5: Add lazy capability detection and secure paths**

`createWorkItemCacheStore` dynamically imports `node:sqlite` on first operation. Import/initialization failure returns stable unavailable errors rather than crashing the server. Reuse `resolveFlowRivetConfigDirectory`; create Unix directory/file with `0700`/`0600`. Keep the adapter constructor injectable with a `DatabaseSync`-compatible constructor for failure tests.

- [ ] **Step 6: Run store tests and typecheck**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/sqlite-work-item-cache-store.test.ts`

Expected: PASS.

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/codex-plugin/src/cache/work-item-cache-store.ts packages/codex-plugin/src/cache/sqlite-work-item-cache-store.ts packages/codex-plugin/src/cache/create-work-item-cache-store.ts packages/codex-plugin/tests/sqlite-work-item-cache-store.test.ts
git commit -m "feat(taskboard): persist work item sync scopes"
```

### Task 4: Merge Live And Cached Scopes In WorkItemService

**Files:**
- Modify: `packages/codex-plugin/src/work-items/work-item-service.ts`
- Test: `packages/codex-plugin/tests/work-item-service.test.ts`

- [ ] **Step 1: Add failing service scenarios**

Cover live, mixed, offline load, partial failure without cache, all failure without cache, cache write failure, cache identity unavailable, seven-day completed-item filtering across both sources, and existing in-flight deduplication. Assert the successful/failed project counters remain project-oriented while freshness counts are scope-oriented.

- [ ] **Step 2: Run service tests and verify failure**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/work-item-service.test.ts`

Expected: FAIL because `WorkItemService` has no cache or freshness support.

- [ ] **Step 3: Implement cache-aware synchronization**

Extend input with optional `cacheAccount?: CacheAccount`; extend output with `dataFreshness`, scope counts, sync timestamps, reason/warning codes. Missing stable identity runs the same online provider flow without cache and returns `cache_identity_unavailable`. Build all live scope results first. If cache merge succeeds, use its transaction result. If it fails, return only successful live scopes with `cache_write_failed`; never discard valid online data or reuse an unconfirmed cached transaction result.

Expose:

```ts
interface WorkItemSynchronizer {
  sync(input: WorkItemSyncInput): Promise<WorkItemSyncSnapshot>;
  loadCached(providerId: string): Promise<WorkItemSyncSnapshot | undefined>;
  clearCached(providerId: string): Promise<void>;
}
```

Keep `inFlight` around the complete provider-plus-cache operation. Apply existing completed-item cutoff and stable sort after merging.

When failed scopes contain different reasons, select the single snapshot `freshnessReasonCode` deterministically using `provider_unauthorized > provider_unavailable > work_item_sync_failed`.

`loadCached` must return the persisted `ProjectRef` values as counted projects as well as cached items. This gives the server enough provider-neutral data to reconstruct the offline `projectCatalog` without calling TAPD or inventing project metadata.

- [ ] **Step 4: Run service tests and typecheck**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/work-item-service.test.ts`

Expected: PASS.

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/codex-plugin/src/work-items/work-item-service.ts packages/codex-plugin/tests/work-item-service.test.ts
git commit -m "feat(taskboard): merge live and cached scopes"
```

### Task 5: Orchestrate Offline Reads, Login Switching, And Disconnect

**Files:**
- Modify: `packages/codex-plugin/src/auth/tapd-auth-service.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/src/observability/work-item-operation-logger.ts`
- Test: `packages/codex-plugin/tests/tapd-auth-service.test.ts`
- Test: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: Write failing authentication and MCP tests**

Test connected live sync, expired/provider-unavailable cache fallback, no-cache error behavior, stable identity missing, mixed metadata, redacted logging, cross-account order, same-account retention, cache-clear failure, credential-write failure, and disconnect ordering.

Use ordered mocks:

```ts
expect(events).toEqual([
  "validate-candidate",
  "clear-project-selection",
  "clear-cache",
  "write-token",
]);
expect(JSON.stringify(logEvents)).not.toMatch(/accountKey|companyId|project|title|token/i);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/tapd-auth-service.test.ts tests/server.test.ts`

Expected: FAIL because auth is one-phase and disconnected snapshots are empty.

- [ ] **Step 3: Split internal session operations from public auth results**

Add internal methods that return `TapdIdentity` only to server-side orchestration:

```ts
validateCandidate(token: string): Promise<TapdIdentity>;
commitCandidate(token: string, identity: TapdIdentity): Promise<AuthResult>;
getSession(): Promise<{ result: AuthResult; identity?: TapdIdentity }>;
```

`getConnectionStatus()` remains the public redacted projection. `commitCandidate` performs only the atomic credential replacement after validation and cleanup have succeeded.

- [ ] **Step 4: Wire one cache instance into server orchestration**

Allow `TaskboardMcpServerOptions` to inject a cache-aware synchronizer for tests. Connected sessions call live sync; stable identity supplies `cacheAccount`, while a connected session without it still returns live data plus `cache_identity_unavailable`. Expired or unavailable sessions call `loadCached("tapd")`; a hit keeps the real connection state and returns `offline`, while a miss preserves the current login/error behavior.

For cross-account login: validate candidate, compare stable namespace identity, clear project selection and old cache while retaining old Token, atomically commit candidate, then sync under the new identity. A failure never activates the candidate identity. For disconnect: clear cache, clear project selection, then delete Token; cache failure must leave Token untouched.

- [ ] **Step 5: Extend redacted operation logging**

Log only `dataFreshness`, fresh/stale scope counts, `cacheOutcome`, existing project/item counts, request ID, duration, and stable error codes. Do not log cache paths, identities, SQL inputs, item/project fields, or exception messages.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/tapd-auth-service.test.ts tests/server.test.ts`

Expected: PASS.

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/codex-plugin/src/auth/tapd-auth-service.ts packages/codex-plugin/src/server/app.ts packages/codex-plugin/src/observability/work-item-operation-logger.ts packages/codex-plugin/tests/tapd-auth-service.test.ts packages/codex-plugin/tests/server.test.ts
git commit -m "feat(plugin): serve cached boards while offline"
```

### Task 6: Present Mixed And Offline States In The Board

**Files:**
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/TaskBoard.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`
- Modify: `packages/codex-plugin/src/ui/components/TapdLogin.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: Write failing UI state and interaction tests**

Test that `offline` data renders instead of the login page, mixed state names the stale-scope count, cached cards expose a visible label and accessible name, reconnect opens a closable Token dialog, closing retains the board, successful login refreshes, and offline detail failure says “重新连接后加载详情”. Also assert the Phase 1A Demo sentence is gone.

- [ ] **Step 2: Run UI tests and verify failure**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx`

Expected: FAIL because disconnected state always replaces the board.

- [ ] **Step 3: Implement board-preserving reconnect flow**

Render a board whenever validated snapshot items/projects exist, regardless of TAPD connection state. Put one full-width status band above columns:

- `mixed`: warning icon, stale-scope count, last successful time.
- `offline`: offline icon, last successful time, `重新连接` command.

Reuse `TapdLogin` inside a native dialog or existing focus-managed dialog pattern. Closing restores focus to the reconnect button and leaves cached data visible. Mark cached cards with a stable-width badge; do not change card/column dimensions.

- [ ] **Step 4: Add responsive and accessibility behavior**

Ensure the status band wraps without horizontal overflow, dialogs trap/restore focus, Escape closes reconnect, status changes use an appropriate live region, and cached labels do not rely on color alone. Preserve reduced-motion behavior.

- [ ] **Step 5: Run UI tests and production UI build**

Run: `npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx`

Expected: PASS.

Run: `npm run build:ui --workspace @flowrivet/codex-plugin`

Expected: PASS with a single bundled `taskboard.html`.

- [ ] **Step 6: Commit**

```bash
git add packages/codex-plugin/src/ui/App.tsx packages/codex-plugin/src/ui/components/TaskBoard.tsx packages/codex-plugin/src/ui/components/WorkItemCard.tsx packages/codex-plugin/src/ui/components/TapdLogin.tsx packages/codex-plugin/src/ui/styles.css packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(taskboard): show mixed and offline data states"
```

### Task 7: Add E2E, Redacted Restart Probe, And Operational Documentation

**Files:**
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Create: `packages/codex-plugin/scripts/probe-work-item-cache.mjs`
- Modify: `packages/codex-plugin/package.json`
- Modify: `docs/operations/codex-plugin-demo.md`

- [ ] **Step 1: Add failing browser journeys**

Add deterministic harness fixtures for `mixed`, `offline`, reconnect dialog, expired cache/no-data login, mobile wrapping, keyboard focus restoration, and cached-card detail failure. Browser tests must assert no horizontal overflow at desktop and mobile viewports.

- [ ] **Step 2: Run E2E and verify the new cases fail**

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: existing journeys pass and new offline journeys fail until harness fixtures/bridge behavior are complete.

- [ ] **Step 3: Complete E2E fixtures and the real read-only probe**

The probe accepts an explicit temporary DB path, invokes one real read-only TAPD sync, disposes the first server/store, creates a second instance against the same temporary DB, and verifies an offline load. It must print only:

```json
{"ok":true,"cacheHit":true,"dataFreshness":"offline","scopeCount":3,"requiredFieldsPresent":true}
```

No identity, project/work-item values, paths, Token, URLs, descriptions, SQL, or response bodies may be printed. Always remove the temporary DB in `finally`; never point at the user config directory.

- [ ] **Step 4: Document local behavior and commands**

Document platform cache paths, seven-day per-scope retention, disconnect deletion, offline/reconnect behavior, Node 22.5 minimum, and the safe probe command. State explicitly that work-item details and credentials are never cached.

- [ ] **Step 5: Run full verification**

Run: `npm test`

Expected: all unit/contract suites PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: all Playwright journeys PASS on desktop and mobile projects.

Run the documented real probe only when a valid local TAPD Token is available. Expected: the redacted JSON shape above; otherwise record the probe as skipped, never fake success.

- [ ] **Step 6: Inspect packaged output and repository diff**

Run: `npm pack --dry-run --workspace @flowrivet/codex-plugin`

Expected: required UI/server files are present; no database, Token, temporary file, or test fixture containing user data is packaged.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 7: Commit**

```bash
git add packages/codex-plugin/e2e/taskboard.spec.ts packages/codex-plugin/scripts/probe-work-item-cache.mjs packages/codex-plugin/package.json docs/operations/codex-plugin-demo.md
git commit -m "test(taskboard): verify offline cache recovery"
```

## Completion Gate

- [ ] Every task commit exists and the worktree is clean.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, and Playwright all pass.
- [ ] A temporary-database restart restores the last valid board for unexpired scopes.
- [ ] Per-scope expiry cannot be extended by success in another scope.
- [ ] Expired/unavailable TAPD shows cached data with an explicit offline state and reconnect entry.
- [ ] Cross-account and disconnect failure tests prove the old Token is not replaced before cache cleanup succeeds.
- [ ] SQLite and logs contain no Token, description, comments, attachments, raw identities, or response bodies.
- [ ] No TAPD write tool, polling loop, drag behavior, or detail persistence was introduced.
