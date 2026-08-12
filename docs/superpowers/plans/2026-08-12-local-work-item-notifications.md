# Local Work Item Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable local work-item change notifications, cross-platform system alerts, and a taskboard notification center without relying on MCP to wake Codex.

**Architecture:** A Companion-owned monitor reuses the provider registry and shared synchronizer, diffs successful snapshots against an account-scoped SQLite baseline, persists deduplicated events, and invokes a narrow system notifier. Provider-neutral MCP tools expose the event inbox to the taskboard and future Codex Automations.

**Tech Stack:** TypeScript, Node.js 22, node:sqlite, MCP SDK, React 19, Vitest, Playwright, native cross-platform desktop notification commands.

---

## File Structure

- `src/contracts/notifications.ts`: closed notification schemas and public types.
- `src/notifications/notification-diff-engine.ts`: pure snapshot-to-event comparison.
- `src/notifications/notification-store.ts`: persistence interface and errors.
- `src/notifications/sqlite-notification-store.ts`: account-scoped baseline/event persistence.
- `src/notifications/system-notifier.ts`: cross-platform notification boundary and URL validation.
- `src/notifications/work-item-notification-monitor.ts`: lifecycle, scheduling, synchronization, and delivery.
- `src/server/runtime-services.ts`: constructs and shares monitor dependencies.
- `src/server/http.ts`, `src/server/index.ts`: start and stop the monitor with Companion.
- `src/server/app.ts`: notification MCP tools.
- `src/ui/components/NotificationCenter.tsx`: notification button and drawer.
- `src/ui/App.tsx`, `src/ui/components/AppHeader.tsx`, `src/ui/styles.css`: inbox integration.

### Task 1: Define notification contracts and pure diffing

**Files:**
- Create: `packages/codex-plugin/src/contracts/notifications.ts`
- Create: `packages/codex-plugin/src/notifications/notification-diff-engine.ts`
- Create: `packages/codex-plugin/tests/notification-diff-engine.test.ts`
- Modify: `packages/codex-plugin/tests/contracts.test.ts`

- [ ] Write failing tests for first baseline, assigned, status, schedule, due-soon, overdue, completed items, exact time boundaries, and duplicate scans.
- [ ] Run `npm test --workspace @flowrivet/codex-plugin -- --run tests/notification-diff-engine.test.ts tests/contracts.test.ts` and verify failure.
- [ ] Add strict Zod schemas and a pure diff result containing new events plus the next item baseline.
- [ ] Generate deterministic dedupe material without logging or exposing stable account keys.
- [ ] Rerun focused tests and typecheck.
- [ ] Commit `feat(notifications): detect work item changes`.

### Task 2: Persist account-scoped baselines and events

**Files:**
- Create: `packages/codex-plugin/src/notifications/notification-store.ts`
- Create: `packages/codex-plugin/src/notifications/sqlite-notification-store.ts`
- Create: `packages/codex-plugin/src/notifications/create-notification-store.ts`
- Create: `packages/codex-plugin/tests/sqlite-notification-store.test.ts`

- [ ] Write failing tests for initialization, first baseline, atomic scan apply, unique dedupe, account isolation, list ordering, single/all read, 30-day purge, and corrupted schema.
- [ ] Run the focused test and verify failure.
- [ ] Implement `notifications.db` with strict tables, foreign keys, transactions, hashed account namespace, and platform permissions.
- [ ] Ensure a failed transaction preserves the previous baseline and events.
- [ ] Rerun focused tests and typecheck.
- [ ] Commit `feat(notifications): persist local notification inbox`.

### Task 3: Add system notification and monitor lifecycle

**Files:**
- Create: `packages/codex-plugin/src/notifications/system-notifier.ts`
- Create: `packages/codex-plugin/src/notifications/work-item-notification-monitor.ts`
- Create: `packages/codex-plugin/tests/system-notifier.test.ts`
- Create: `packages/codex-plugin/tests/work-item-notification-monitor.test.ts`
- [ ] Implement native platform commands with argv-only process spawning after rejecting notification dependencies with known security advisories.
- [ ] Write failing monitor tests for delayed first scan, connected sync, disconnected skip, no initial alerts, single-flight, sync failure, notifier failure, interval validation, and stop.
- [ ] Write URL allowlist and notifier adapter tests; CI must use a fake notifier only.
- [ ] Implement the monitor against narrow registry/store/synchronizer interfaces.
- [ ] Persist events before attempting system delivery; notifier failure must not roll back events.
- [ ] Rerun focused tests, typecheck, and package dry-run.
- [ ] Commit `feat(companion): monitor work item notifications`.

### Task 4: Start the monitor with shared Companion services

**Files:**
- Modify: `packages/codex-plugin/src/server/runtime-services.ts`
- Modify: `packages/codex-plugin/src/server/taskboard-runtime.ts`
- Modify: `packages/codex-plugin/src/server/http.ts`
- Modify: `packages/codex-plugin/src/server/index.ts`
- Modify: `packages/codex-plugin/tests/taskboard-runtime.test.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [ ] Write failing lifecycle tests proving one monitor per Companion, no monitor per MCP request, shared synchronizer identity, and close cleanup.
- [ ] Expose the notification store and monitor through `RuntimeServices` without creating provider duplicates.
- [ ] Start after HTTP listen and stop during server close/signals.
- [ ] Keep `/health` responsive and add only non-sensitive monitor state such as `running` or `degraded` if operationally needed.
- [ ] Rerun runtime/server tests and typecheck.
- [ ] Commit `feat(companion): run notification monitor lifecycle`.

### Task 5: Expose provider-neutral notification tools

**Files:**
- Modify: `packages/codex-plugin/src/server/app.ts`
- Create: `packages/codex-plugin/src/observability/notification-operation-logger.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [ ] Write failing MCP tests for list, unread-only, single read, all read, account isolation, idempotency, annotations, stable errors, and redacted logs.
- [ ] Register `list_work_item_notifications`, `mark_work_item_notification_read`, and `mark_all_work_item_notifications_read`.
- [ ] Resolve the current stable account through the active Provider auth service before every operation.
- [ ] Return only schema-validated structured content and approved aggregate logs.
- [ ] Rerun server tests and typecheck.
- [ ] Commit `feat(plugin): expose work item notifications`.

### Task 6: Build the taskboard notification center

**Files:**
- Create: `packages/codex-plugin/src/ui/components/NotificationCenter.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/AppHeader.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] Write failing UI tests for initial unread load, stable badge size, drawer open/close, retry, single read, all read, valid/invalid links, focus restoration, empty state, and 30-second open-drawer refresh.
- [ ] Implement a header bell icon and accessible right-side drawer; do not nest cards.
- [ ] Mark an event read before opening its validated Provider URL.
- [ ] Preserve existing full-screen, connection menu, board filtering, and mobile behavior.
- [ ] Rerun UI tests, typecheck, and UI build.
- [ ] Commit `feat(taskboard): add notification center`.

### Task 7: Add browser acceptance and user guidance

**Files:**
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `docs/user-guide.md`
- Modify: `docs/operations/codex-plugin-demo.md`
- Modify: `tests/codex-plugin-docs.test.ts`

- [ ] Add synthetic notification tool responses to the demo harness.
- [ ] Add desktop and mobile Playwright journeys for badge, drawer, read actions, URL opening, focus, and overflow.
- [ ] Document notification semantics, privacy, retention, OS permission recovery, and the MCP/Codex Automation boundary.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and plugin E2E.
- [ ] Run `npm pack --dry-run --json --workspace @flowrivet/codex-plugin`, `git diff --check`, and `git status --short`.
- [ ] Commit `test(notifications): verify local notification workflow`.

## Completion Gate

- [ ] First scan establishes a baseline without alert storms.
- [ ] Five event types are detected once per meaningful change.
- [ ] Account switching cannot reveal or mutate another account's notifications.
- [ ] Companion restart preserves dedupe and read state.
- [ ] System notification failures retain inbox events and do not stop polling.
- [ ] Background scans reuse the shared Provider and synchronizer.
- [ ] MCP tools remain local and cannot claim to wake Codex.
- [ ] The taskboard has an accessible, responsive notification center.
- [ ] No credentials, CLI output, descriptions, comments, attachments, account keys, or business URLs enter logs.
- [ ] Full tests, typecheck, build, E2E, package inspection, and diff checks pass.
