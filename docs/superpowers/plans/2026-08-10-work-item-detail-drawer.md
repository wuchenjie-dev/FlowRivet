# Work Item Detail Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 FlowRivet 看板点击任意真实工作项后，以只读抽屉查看最新详情，同时保持项目管理系统无关的领域边界和严格的当前用户授权校验。

**Architecture:** 新增独立的 `WorkItemDetailProvider` 端口和详情服务，由 MCP 工具先验证连接与可访问项目，再委托 TAPD 适配器按工作项类型实时读取。服务端统一清洗富文本并返回稳定错误码；React UI 只渲染已清洗内容，在会话内缓存详情并在刷新或身份变化时失效。

**Tech Stack:** TypeScript, Zod, MCP Apps SDK, React 19, Vitest, Testing Library, Playwright, sanitize-html, TAPD Open API

---

## Task 1: Define provider-neutral detail contracts and authorization service

**Files:**
- Create: `packages/codex-plugin/src/contracts/work-item-detail.ts`
- Create: `packages/codex-plugin/src/work-items/work-item-detail-provider.ts`
- Create: `packages/codex-plugin/src/work-items/work-item-detail-service.ts`
- Create: `packages/codex-plugin/tests/work-item-detail-service.test.ts`
- Modify: `packages/codex-plugin/tests/contracts.test.ts`

- [ ] Write contract tests for accepted story/task/bug references, normalized detail output, HTTPS external URLs, and rejected malformed inputs.
- [ ] Write service tests proving the requested project must exist in the current accessible catalog, unavailable projects are rejected, and provider errors keep stable public codes.
- [ ] Run `npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts work-item-detail-service.test.ts` and confirm the new tests fail for missing implementation.
- [ ] Add `workItemDetailRefSchema`, `workItemDetailSchema`, exported TypeScript types, `WorkItemDetailProvider`, and `WorkItemDetailProviderError`.
- [ ] Implement `WorkItemDetailService.get()` with provider-neutral project authorization before delegating to the adapter.
- [ ] Re-run the focused tests and `npm run typecheck --workspace @flowrivet/codex-plugin`.
- [ ] Commit with `git add packages/codex-plugin/src/contracts/work-item-detail.ts packages/codex-plugin/src/work-items/work-item-detail-provider.ts packages/codex-plugin/src/work-items/work-item-detail-service.ts packages/codex-plugin/tests/contracts.test.ts packages/codex-plugin/tests/work-item-detail-service.test.ts && git commit -m "feat(taskboard): define work item detail contract"`.

## Task 2: Sanitize and bound provider descriptions

**Files:**
- Create: `packages/codex-plugin/src/work-items/sanitize-description.ts`
- Create: `packages/codex-plugin/tests/sanitize-description.test.ts`
- Modify: `packages/codex-plugin/package.json`
- Modify: `package-lock.json`

- [ ] Add `sanitize-html` as a runtime dependency and its TypeScript declarations as a development dependency.
- [ ] Write attack-focused tests covering scripts, styles, iframes, images, forms, inline handlers, style/class/data attributes, unsafe protocols, and link hardening.
- [ ] Write tests for the exact allowlist (`p`, `br`, `ul`, `ol`, `li`, `strong`, `em`, `code`, `pre`, `a`) and the 256 KiB output cap with a truncation indicator.
- [ ] Run `npm test --workspace @flowrivet/codex-plugin -- sanitize-description.test.ts` and confirm failure.
- [ ] Implement `sanitizeDescription()` so oversized sanitized output falls back to a safely escaped, bounded text representation instead of cutting HTML tokens.
- [ ] Re-run the focused tests and typecheck.
- [ ] Commit with `git add packages/codex-plugin/package.json package-lock.json packages/codex-plugin/src/work-items/sanitize-description.ts packages/codex-plugin/tests/sanitize-description.test.ts && git commit -m "feat(taskboard): sanitize work item descriptions"`.

## Task 3: Implement the TAPD detail adapter

**Files:**
- Create: `packages/codex-plugin/src/work-items/tapd-work-item-detail-provider.ts`
- Create: `packages/codex-plugin/tests/tapd-work-item-detail-provider.test.ts`

- [ ] Write request tests for `GET /stories`, `/tasks`, and `/bugs` with `workspace_id`, `id`, and `limit=1`.
- [ ] Write mapping tests for title, provider status, priority, assignees, creator, timestamps, description, external URL, and provider item type.
- [ ] Write authorization tests requiring exact workspace, item ID, and current-user assignee matches; include comma/semicolon-delimited TAPD owner values without substring matching.
- [ ] Write error tests mapping disconnected credentials, 401/403, empty/404, 5xx/network failures, unsupported types, and malformed responses to the stable codes in the design spec.
- [ ] Run `npm test --workspace @flowrivet/codex-plugin -- tapd-work-item-detail-provider.test.ts` and confirm failure.
- [ ] Implement `TapdWorkItemDetailProvider` using the existing credential resolver and fetch conventions, then pass descriptions through `sanitizeDescription()`.
- [ ] Re-run the focused tests and typecheck.
- [ ] Commit with `git add packages/codex-plugin/src/work-items/tapd-work-item-detail-provider.ts packages/codex-plugin/tests/tapd-work-item-detail-provider.test.ts && git commit -m "feat(tapd): fetch authorized work item details"`.

## Task 4: Expose a read-only MCP detail tool with safe observability

**Files:**
- Create: `packages/codex-plugin/src/observability/work-item-detail-operation-logger.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [ ] Extend server tests to assert `get_work_item_detail` is registered as read-only/open-world and accepts only the provider-neutral reference fields.
- [ ] Add success tests proving the tool resolves current identity and current accessible project catalog before invoking the detail service.
- [ ] Add failure/logging tests proving request IDs, duration, provider ID, item type, and error code are recorded while title, description, token, and raw provider response are never logged.
- [ ] Run `npm test --workspace @flowrivet/codex-plugin -- server.test.ts` and confirm failure.
- [ ] Add injectable detail-service and logger options, wire the TAPD implementation by default, and register `get_work_item_detail` with the detail schema as its output.
- [ ] Implement structured stderr logging with one request ID per call and redacted metadata only.
- [ ] Re-run server tests and typecheck.
- [ ] Commit with `git add packages/codex-plugin/src/server/app.ts packages/codex-plugin/src/observability/work-item-detail-operation-logger.ts packages/codex-plugin/tests/server.test.ts && git commit -m "feat(plugin): expose work item detail tool"`.

## Task 5: Build the accessible detail drawer and session cache

**Files:**
- Create: `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/TaskBoard.tsx`
- Modify: `packages/codex-plugin/src/ui/components/TaskColumn.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] Write UI tests proving the entire card opens detail and calls `get_work_item_detail` with only `providerId`, `projectExternalId`, `providerItemType`, and `externalId`.
- [ ] Cover loading, success, empty optional fields, retryable provider failure, forbidden/not-found copy, and a working external HTTPS link.
- [ ] Cover session caching, cache clearing after refresh/login/disconnect, and stale-response suppression when users switch cards quickly.
- [ ] Cover focus transfer, focus trap, Escape/overlay close, focus restoration, and keyboard activation of a card.
- [ ] Run `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx` and confirm failure.
- [ ] Thread `onOpenItem` through board/column/card components and replace the card title link with an accessible button-like card interaction.
- [ ] Implement `WorkItemDetailDrawer` with desktop overlay width `min(520px, 42vw)`, a mobile full-screen layer, fixed close control, semantic field rows, and sanitized rich-text rendering.
- [ ] Add App-level request state, `Map`-backed session cache, request sequence guards, retry, and cache invalidation at identity/snapshot boundaries.
- [ ] Re-run UI tests, typecheck, and `npm run build:ui --workspace @flowrivet/codex-plugin`.
- [ ] Commit with `git add packages/codex-plugin/src/ui packages/codex-plugin/tests/ui.test.tsx && git commit -m "feat(taskboard): add work item detail drawer"`.

## Task 6: Extend the demo harness and browser coverage

**Files:**
- Modify: `packages/codex-plugin/src/demo/fixtures.ts`
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`

- [ ] Add deterministic detail fixtures for each work item kind, including harmless rich text and sanitized-link behavior.
- [ ] Teach the harness to answer `get_work_item_detail`, optionally delay responses for rapid-switch testing, and return stable failure scenarios.
- [ ] Add Playwright desktop tests for card activation, overlay geometry, close behavior, external link attributes, and content rendering.
- [ ] Add mobile tests proving the detail layer occupies the viewport without text overlap or horizontal overflow.
- [ ] Add keyboard-only tests for open, focus containment, Escape, and focus restoration.
- [ ] Run `npm run test:e2e --workspace @flowrivet/codex-plugin` and inspect desktop/mobile screenshots on failure.
- [ ] Commit with `git add packages/codex-plugin/src/demo/fixtures.ts packages/codex-plugin/src/ui/demo-harness.tsx packages/codex-plugin/e2e/taskboard.spec.ts && git commit -m "test(taskboard): cover detail drawer journeys"`.

## Task 7: Document, package, and validate against real TAPD data

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/codex-plugin-local-runbook.md` (or the existing local Companion operations guide discovered in the repository)
- Modify: plugin cache-buster/version metadata files discovered by `rg "0.1.0\\+codex"`

- [ ] Document the read-only detail flow, required TAPD token permissions, supported item kinds, local-only data path, error behavior, and security boundary.
- [ ] Run a local Companion and call `get_work_item_detail` for one real current-user item; record only request ID, item kind, project ID, success/failure code, and field-presence booleans, never the description or token.
- [ ] Install/update the local FlowRivet plugin cache-buster so Codex loads the new UI bundle.
- [ ] Run `npm test`, `npm run typecheck --workspace @flowrivet/codex-plugin`, `npm run build --workspace @flowrivet/codex-plugin`, and `npm run test:e2e --workspace @flowrivet/codex-plugin`.
- [ ] Run `git status --short`, inspect `git diff --check`, and verify no credential, TAPD response body, generated screenshot, or unrelated worktree file is staged.
- [ ] Commit documentation and packaging changes with `git commit -m "docs(taskboard): document detail drawer operations"`.
- [ ] Perform the final code review inline against `docs/superpowers/specs/2026-08-10-work-item-detail-drawer-design.md`, fix any findings, repeat the complete verification suite, and commit fixes separately if needed.

