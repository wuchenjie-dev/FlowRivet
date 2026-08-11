# FlowRivet Local Plugin Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide one reliable local command that updates the currently installed FlowRivet Codex plugin, restarts and verifies Companion, and tells the user when Codex itself must be restarted.

**Architecture:** The root CLI owns a provider-neutral update orchestrator. Small adapters locate the current source and local marketplace, run Git and Codex commands, protect the plugin manifest with a crash-safe external journal, and manage a verified Companion process. The Companion publishes an instance identity through both a local registry file and `/health`, so later updates stop only the process they own. `npm run plugin:update` bootstraps the same CLI service rather than implementing a second update path.

**Tech Stack:** TypeScript, Node.js built-ins, Vitest, npm workspaces, Codex CLI, official `plugin-creator` cachebuster helper.

---

## Task 1: Define the updater command contract

**Files:**
- Create: `src/plugin-update/contracts.ts`
- Create: `src/plugin-update/command-runner.ts`
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`
- Create: `tests/plugin-update-command-runner.test.ts`

- [x] Add failing CLI tests for `plugin update`, `--pull`, `--json`, `--adopt-legacy-companion`, unknown options, and stable updater error codes.
- [x] Run `npm test -- tests/cli.test.ts tests/plugin-update-command-runner.test.ts` and confirm the new cases fail because the command is not implemented.
- [x] Add updater result/error contracts and a bounded, injectable `spawn`-based command runner that captures stdout/stderr without invoking a shell.
- [x] Extend `runCli` with an injected `updatePlugin` service and parse the new command without changing existing command behavior.
- [x] Emit concise human output by default and a single JSON object with no prompts in `--json` mode.
- [x] Re-run the focused tests and `npm run typecheck`.
- [x] Commit: `feat(plugin): add local update command contract`

## Task 2: Locate the source, Codex CLI, and installed plugin

**Files:**
- Create: `src/plugin-update/source-locator.ts`
- Create: `src/plugin-update/codex-locator.ts`
- Create: `src/plugin-update/marketplace-locator.ts`
- Create: `tests/plugin-update-source-locator.test.ts`
- Create: `tests/plugin-update-marketplace-locator.test.ts`

- [x] Add failing table-driven tests for source discovery from the current checkout, packaged CLI paths, symlinks/junctions, and unsupported layouts.
- [x] Add failing tests for Codex executable lookup and for zero, one, or multiple enabled local marketplace entries matching the source.
- [x] Run `npm test -- tests/plugin-update-source-locator.test.ts tests/plugin-update-marketplace-locator.test.ts` and confirm the expected failures.
- [x] Implement canonical path comparison that is case-insensitive on Windows and resolves links before comparing.
- [x] Read marketplace metadata only; require exactly one installed and enabled local plugin whose source resolves to the current checkout.
- [x] Locate the bundled Codex executable first, then fall back to `codex` on `PATH`, and validate it with a bounded version command.
- [x] Re-run focused tests and `npm run typecheck`.
- [x] Commit: `feat(plugin): discover installed local plugin`

## Task 3: Make manifest installation crash-safe

**Files:**
- Create: `src/plugin-update/manifest-transaction.ts`
- Create: `src/plugin-update/plugin-installer.ts`
- Create: `tests/plugin-update-manifest-transaction.test.ts`
- Create: `tests/plugin-update-plugin-installer.test.ts`

- [x] Add failing tests for transaction creation, original restoration, stale-journal recovery, already-restored cleanup, hash conflict refusal, lock contention, and cleanup after command failure.
- [x] Add failing installer tests that assert use of the official `update_plugin_cachebuster.py` helper followed by `codex plugin add`, without hand-editing marketplace JSON.
- [x] Run the focused tests and confirm they fail.
- [x] Implement an exclusive update lock plus an external journal containing source path, backup path, original hash, temporary hash, timestamps, and state.
- [x] Restore the exact original manifest bytes in `finally`; preserve conflicting evidence and return `manifest_recovery_conflict` rather than overwriting unknown changes.
- [x] Locate Python and the helper beneath the active Codex home, run the helper against the source manifest, install through Codex CLI, and restore the source manifest.
- [x] Verify tests leave both the fixture repository and manifest byte-identical after success and failure.
- [x] Re-run focused tests and `npm run typecheck`.
- [x] Commit: `feat(plugin): install with crash-safe manifest transaction`

## Task 4: Add guarded Git pull and fresh-updater re-exec

**Files:**
- Create: `src/plugin-update/git-updater.ts`
- Create: `tests/plugin-update-git-updater.test.ts`
- Modify: `src/plugin-update/contracts.ts`

- [x] Add failing tests for default no-pull behavior, dirty worktree refusal, missing upstream refusal, `git pull --ff-only`, pull failure, and the one-time re-exec guard.
- [x] Run `npm test -- tests/plugin-update-git-updater.test.ts` and confirm failures.
- [x] Implement clean-worktree and upstream checks before `--pull`.
- [x] After a successful pull, rebuild the minimal root CLI and re-exec `plugin update` once with an internal environment guard so newly pulled updater logic runs the transaction.
- [x] Preserve user flags and prevent recursive re-execution.
- [x] Re-run focused tests and `npm run typecheck`.
- [x] Commit: `feat(plugin): support guarded source updates`

## Task 5: Give Companion a verifiable instance identity

**Files:**
- Create: `packages/codex-plugin/src/server/companion-instance.ts`
- Create: `packages/codex-plugin/tests/companion-instance.test.ts`
- Modify: `packages/codex-plugin/src/server/http.ts`
- Modify: `packages/codex-plugin/src/server/index.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [x] Add failing tests for cross-platform default registry paths, atomic instance-file writes, stale-file cleanup, and explicit `FLOWRIVET_COMPANION_INSTANCE_FILE` override.
- [x] Add failing server tests requiring `/health` to return `product`, `pid`, and `instanceId` while retaining `status: "ok"`.
- [x] Run `npm test --workspace @flowrivet/codex-plugin -- companion-instance.test.ts server.test.ts` and confirm failures.
- [x] Generate one instance ID per server process, expose it from `/health`, and atomically write the registry after the listener is ready.
- [x] Store PID, OS process start time, host, port, instance ID, and startup timestamp; remove the file only when it still identifies the exiting instance.
- [x] Handle normal exit signals without changing existing server APIs used by tests.
- [x] Re-run workspace tests, typecheck, and build.
- [x] Commit: `feat(companion): publish verified instance identity`

## Task 6: Restart Companion safely across platforms

**Files:**
- Create: `src/plugin-update/companion-paths.ts`
- Create: `src/plugin-update/companion-process-manager.ts`
- Create: `tests/plugin-update-companion-process-manager.test.ts`
- Modify: `src/plugin-update/contracts.ts`

- [x] Add failing process-adapter tests for Windows, Linux, and macOS PID/start-time inspection, graceful stop, forced stop timeout, detached startup, and health polling.
- [x] Add failing ownership tests that reject PID reuse, mismatched health identity, non-loopback hosts, and unrelated Node processes.
- [x] Add failing legacy tests for exact old server command detection, strict `{status:"ok"}` health, interactive confirmation, JSON/non-TTY refusal, `--adopt-legacy-companion`, and revalidation immediately before termination.
- [x] Run the focused tests and confirm failures.
- [x] Implement platform adapters using argument arrays and no shell interpolation.
- [x] Stop a managed Companion only when registry PID, process start time, and health identity all match.
- [x] Adopt the old FlowRivet Companion only under the design's exact checks and explicit consent; otherwise return `companion_legacy_confirmation_required`.
- [x] Start the built Companion detached with an explicit instance-file path, poll health to a bounded deadline, and fail the update if identity validation does not succeed.
- [x] Re-run focused tests and `npm run typecheck`.
- [x] Commit: `feat(plugin): safely restart local companion`

## Task 7: Orchestrate the full update and npm bootstrap

**Files:**
- Create: `src/plugin-update/plugin-update-service.ts`
- Create: `tests/plugin-update-service.test.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `poc.md`

- [x] Add failing orchestration tests for the exact order: recover transaction, optionally pull/re-exec, build, install plugin, restore manifest, stop verified Companion, start Companion, verify health, report Codex restart instructions.
- [x] Add failure tests proving the old Companion remains available until both the build and plugin installation succeed, the manifest always restores, startup failures are surfaced, and JSON output stays machine-readable.
- [x] Run `npm test -- tests/plugin-update-service.test.ts tests/cli.test.ts` and confirm failures.
- [x] Compose the updater adapters behind `createPluginUpdateService` and keep side effects injectable.
- [x] Add `npm run plugin:update` as a minimal bootstrap build followed by the same `flowrivet plugin update` code path.
- [x] Document normal, `--pull`, JSON, legacy-adoption, recovery-conflict, and "restart Codex then open a new task" workflows in Chinese-facing project docs.
- [x] Re-run focused tests, `npm run typecheck`, and `npm run build`.
- [x] Commit: `feat(plugin): deliver one-command local updates`

## Task 8: Review, harden, and perform real local acceptance

**Files:**
- Modify as findings require: updater and Companion files from Tasks 1-7
- Modify: `docs/superpowers/specs/2026-08-11-flowrivet-plugin-update-design.md` only if implementation proves a factual constraint wrong

- [x] Run the full suite: `npm test`.
- [x] Run `npm run typecheck` and `npm run build`.
- [x] Inspect `git status --short` and verify no generated manifest, journal, backup, log, or `dist` files are tracked.
- [x] Review the complete diff for correctness, maintainability, project standards, and test gaps; fix every blocking finding with a focused regression test.
- [x] Commit review fixes separately if any: `fix(plugin): address update workflow review`
- [ ] Execute `npm run plugin:update -- --adopt-legacy-companion --json` against the currently installed `flowrivet@flowrivet-worktree` plugin.
- [ ] Verify the command reports success, the manifest hash matches its pre-update hash, the marketplace entry remains uniquely enabled, `/health` returns the new identity, and the instance file matches it.
- [ ] Restart Codex manually, open a new task, and confirm the FlowRivet plugin UI loads the latest version without reinstalling or rebuilding by hand.
- [ ] Commit any acceptance-only fixes with regression tests.
- [ ] Push `codex/feishu-project-provider` and report the exact command users should run for future local updates.
