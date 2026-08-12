# FlowRivet Companion Internal Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a cross-platform FlowRivet Updater that silently installs verified Companion and MCP Apps UI releases from an internal GitLab Generic Package Registry while keeping the stable Codex plugin shell unchanged.

**Architecture:** A new `@flowrivet/updater` workspace owns the release manifest, GitLab package download, OS credential access, version store, activation state machine, rollback, scheduling, and user-level startup registration. The existing Companion publishes a versioned health contract and versioned MCP App resource URI; GitLab CI builds immutable self-contained runtime packages and updates a single stable channel pointer only after all artifacts pass verification.

**Tech Stack:** TypeScript 5.9, Node.js 22 private runtime, Zod 4, Vitest, MCP Apps, GitLab CI/CD, GitLab Generic Package Registry, Windows Credential Manager/Task Scheduler, macOS Keychain/LaunchAgent, Linux Secret Service/systemd user services.

---

## Scope And File Map

The ordinary-user updater is intentionally separate from `src/plugin-update/`, which remains the developer checkout updater behind `npm run plugin:update`.

### New updater workspace

- `packages/updater/package.json`: workspace scripts, package metadata, and runtime dependencies.
- `packages/updater/tsconfig.json`: build updater sources into `dist/`.
- `packages/updater/src/contracts/release-manifest.ts`: versioned stable channel and release manifest schemas.
- `packages/updater/src/contracts/update-state.ts`: persistent activation, cooldown, and error contracts.
- `packages/updater/src/config/update-config.ts`: non-secret GitLab project, package, channel, redirect allowlist, and credential-reference configuration.
- `packages/updater/src/config/update-config-store.ts`: versioned atomic configuration persistence.
- `packages/updater/src/gitlab/generic-package-client.ts`: authenticated package file downloads only; no general GitLab API discovery.
- `packages/updater/src/credentials/credential-store.ts`: platform-neutral credential interface and stable errors.
- `packages/updater/src/credentials/windows-credential-store.ts`: Windows Credential Manager adapter.
- `packages/updater/src/credentials/macos-keychain-store.ts`: macOS Keychain adapter.
- `packages/updater/native/macos-keychain/main.swift`: packaged Security.framework helper that reads secrets from stdin.
- `packages/updater/src/credentials/linux-secret-service-store.ts`: Linux Secret Service adapter.
- `packages/updater/src/credentials/index.ts`: platform adapter selection.
- `packages/updater/src/storage/update-paths.ts`: cross-platform application data paths.
- `packages/updater/src/storage/version-store.ts`: staging directories, immutable version directories, atomic pointers, and cleanup.
- `packages/updater/src/download/package-downloader.ts`: bounded streaming download and SHA-256 verification.
- `packages/updater/src/download/archive-extractor.ts`: allowlisted ZIP/tar extraction with traversal, link, count, and expanded-size limits.
- `packages/updater/src/logging/update-logger.ts`: structured redacted updater events and request IDs.
- `packages/updater/src/companion/companion-controller.ts`: packaged-runtime Companion start, ownership verification, stop, and health polling.
- `packages/updater/src/update/update-service.ts`: single update transaction and rollback state machine.
- `packages/updater/src/update/update-scheduler.ts`: startup check, 30-minute interval, deterministic jitter, backoff, and single flight.
- `packages/updater/src/startup/startup-manager.ts`: platform-neutral user startup interface.
- `packages/updater/src/startup/windows-task-scheduler.ts`: hidden logon task registration.
- `packages/updater/src/startup/macos-launch-agent.ts`: user LaunchAgent registration.
- `packages/updater/src/startup/linux-systemd-user.ts`: user service registration and unsupported-state reporting.
- `packages/updater/src/cli.ts`: `configure`, `run`, `check`, `status`, and `uninstall-startup` commands.
- `packages/updater/src/index.ts`: background process entry point.

### Existing Companion and UI

- `packages/codex-plugin/src/contracts/runtime-version.ts`: shared runtime version and protocol schema.
- `packages/codex-plugin/src/server/companion-instance.ts`: persist runtime, protocol, and UI versions.
- `packages/codex-plugin/src/server/http.ts`: return the expanded `/health` contract.
- `packages/codex-plugin/src/server/index.ts`: derive version metadata from packaged build input.
- `packages/codex-plugin/src/server/app.ts`: register a versioned MCP App resource URI.
- `packages/codex-plugin/src/ui/use-runtime-version.ts`: poll runtime version while the board is visible.
- `packages/codex-plugin/src/ui/components/UpdateReadyNotice.tsx`: non-blocking reopen/restart guidance.
- `packages/codex-plugin/src/ui/App.tsx`: attach runtime-version behavior to the board.
- `packages/codex-plugin/src/ui/styles.css`: compact update notice styles.

### Release and operations

- `.gitlab-ci.yml`: protected-tag build, cross-platform package, verify, and serialized publish jobs.
- `scripts/release/build-runtime-package.mjs`: assemble Companion, UI, production dependencies, private Node runtime, licenses, and metadata.
- `scripts/release/create-release-manifest.mjs`: create deterministic package hashes and release manifest.
- `scripts/release/publish-generic-package.mjs`: upload immutable files, verify downloads, then publish the channel pointer.
- `scripts/release/verify-runtime-package.mjs`: unpack and health-check a platform package.
- `scripts/release/runtime-checksums.json`: pinned private Node runtime mirror URLs, SHA-256 values, and licenses by platform.
- `scripts/install/install-flowrivet.ps1`: Windows user installation and secure interactive token configuration.
- `scripts/install/install-flowrivet.sh`: macOS/Linux user installation and secure interactive token configuration.
- `docs/operations/internal-auto-update.md`: administrator deployment, token rotation, rollback, and troubleshooting guide.
- `docs/user-guide.md`: ordinary-user update behavior and recovery messages.

## Task 1: Establish The Runtime Version And MCP App Compatibility Contract

**Files:**
- Create: `packages/codex-plugin/src/contracts/runtime-version.ts`
- Create: `packages/codex-plugin/tests/runtime-version.test.ts`
- Modify: `packages/codex-plugin/src/server/companion-instance.ts`
- Modify: `packages/codex-plugin/src/server/http.ts`
- Modify: `packages/codex-plugin/src/server/index.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/tests/companion-instance.test.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: Add failing schemas and health-contract tests**

Test a strict `RuntimeVersion` containing semantic `version`, integer `protocolVersion`, and semantic `uiVersion`. Extend server fixtures so `/health` must return all three fields and reject missing or malformed build metadata.

```ts
expect(runtimeVersionSchema.parse({
  version: "0.2.1",
  protocolVersion: 1,
  uiVersion: "0.2.1",
})).toEqual({ version: "0.2.1", protocolVersion: 1, uiVersion: "0.2.1" });
```

- [ ] **Step 2: Add a failing versioned-resource test**

Require `open_my_taskboard` metadata and `resources/read` to use `ui://flowrivet/taskboard/0.2.1.html`, not the current fixed `ui://flowrivet/taskboard.html`. Verify the HTML response URI exactly matches tool metadata.

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- runtime-version.test.ts companion-instance.test.ts server.test.ts
```

Expected: FAIL because version metadata and the versioned resource URI do not exist.

- [ ] **Step 4: Implement the shared version contract**

Export `FLOWRIVET_PROTOCOL_VERSION = 1`, `runtimeVersionSchema`, and `RuntimeVersion`. Read build values from `FLOWRIVET_RUNTIME_VERSION` and `FLOWRIVET_UI_VERSION`, using package version only in development; production packaging must always set explicit values.

- [ ] **Step 5: Extend health and instance identity**

Add version fields to `CompanionHealth` and `CompanionInstance`. Preserve `product`, `pid`, and `instanceId` so the existing ownership checks remain valid.

- [ ] **Step 6: Register the versioned MCP App resource**

Replace the constant URI with a pure helper:

```ts
export function taskboardResourceUri(uiVersion: string) {
  return `ui://flowrivet/taskboard/${encodeURIComponent(uiVersion)}.html`;
}
```

Inject `runtimeVersion` through `TaskboardMcpServerOptions`; do not read environment variables inside request handlers.

- [ ] **Step 7: Re-run focused checks**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- runtime-version.test.ts companion-instance.test.ts server.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
```

Expected: PASS.

- [ ] **Step 8: Commit the compatibility boundary**

```powershell
git add packages/codex-plugin/src/contracts/runtime-version.ts packages/codex-plugin/src/server/companion-instance.ts packages/codex-plugin/src/server/http.ts packages/codex-plugin/src/server/index.ts packages/codex-plugin/src/server/app.ts packages/codex-plugin/tests/runtime-version.test.ts packages/codex-plugin/tests/companion-instance.test.ts packages/codex-plugin/tests/server.test.ts
git commit -m "feat(companion): publish versioned runtime contract"
```

## Task 2: Define Immutable Release Manifests And GitLab Downloads

**Files:**
- Create: `packages/updater/package.json`
- Create: `packages/updater/tsconfig.json`
- Create: `packages/updater/src/contracts/release-manifest.ts`
- Create: `packages/updater/src/config/update-config.ts`
- Create: `packages/updater/src/config/update-config-store.ts`
- Create: `packages/updater/src/gitlab/generic-package-client.ts`
- Create: `packages/updater/src/logging/update-logger.ts`
- Create: `packages/updater/tests/release-manifest.test.ts`
- Create: `packages/updater/tests/update-config-store.test.ts`
- Create: `packages/updater/tests/generic-package-client.test.ts`
- Create: `packages/updater/tests/update-logger.test.ts`
- Modify: `package-lock.json`

- [ ] **Step 1: Scaffold only the updater workspace metadata**

Use the existing npm workspace layout and Vitest conventions. Add scripts for `build`, `typecheck`, and `test`; do not add an application framework or HTTP client dependency because Node `fetch` is sufficient.

- [ ] **Step 2: Write failing manifest validation tests**

Cover valid schema version 1, unknown schema, invalid semver, rollback version, missing platform, path traversal in file/package fields, invalid SHA-256, negative/oversized size, unsupported protocol, and inconsistent channel/release manifests.

- [ ] **Step 3: Write failing GitLab client tests**

Use an injected `fetch` to assert the exact endpoint:

```text
/api/v4/projects/<encoded-id>/packages/generic/<package>/<version>/<file>
```

Assert `DEPLOY-TOKEN` is set from an argument, redirects are bounded, authentication is removed before an approved object-storage redirect, response bodies are size-bounded, and errors never include token or response body.

- [ ] **Step 4: Write failing configuration and logging tests**

Require a versioned non-secret config containing HTTPS GitLab base URL, project ID, package/channel names, exact redirect-host allowlist, and credential reference. Cover atomic persistence, corrupt/unknown schema rejection, prohibition of embedded username/token/password fields, restrictive file permissions where supported, a generated `requestId` per check, and JSON log redaction for authorization headers, URLs, response bodies, user identities, and task content.

- [ ] **Step 5: Run the focused tests and confirm failure**

Run:

```powershell
npm test --workspace @flowrivet/updater -- release-manifest.test.ts update-config-store.test.ts generic-package-client.test.ts update-logger.test.ts
```

Expected: FAIL because the workspace implementation is absent.

- [ ] **Step 6: Implement strict manifest schemas**

Keep `channelManifestSchema` and `releaseManifestSchema` separate even when their initial payloads are identical. Provide `assertCompatibleRelease(channel, release, currentVersion, supportedProtocol)` that rejects version rollback and byte-contract mismatch.

- [ ] **Step 7: Implement non-secret config and structured logging**

Keep configuration independent of the OS credential store. Every updater stage receives a `requestId` and logs only stage, current/target version, platform, duration, outcome, and stable error code. Add a central redactor even though callers should already provide safe fields.

- [ ] **Step 8: Implement package-file-only GitLab access**

The client exposes only `downloadChannelManifest`, `downloadReleaseManifest`, and `downloadPackageFile`. It must not call `/projects/:id/packages` or other generic APIs because the chosen Deploy Token is limited to package registry access.

- [ ] **Step 9: Re-run checks**

Run:

```powershell
npm test --workspace @flowrivet/updater -- release-manifest.test.ts update-config-store.test.ts generic-package-client.test.ts update-logger.test.ts
npm run typecheck --workspace @flowrivet/updater
```

Expected: PASS.

- [ ] **Step 10: Commit the Registry contract**

```powershell
git add packages/updater/package.json packages/updater/tsconfig.json packages/updater/src/contracts/release-manifest.ts packages/updater/src/config packages/updater/src/gitlab/generic-package-client.ts packages/updater/src/logging/update-logger.ts packages/updater/tests/release-manifest.test.ts packages/updater/tests/update-config-store.test.ts packages/updater/tests/generic-package-client.test.ts packages/updater/tests/update-logger.test.ts package-lock.json
git commit -m "feat(updater): define internal release contract"
```

## Task 3: Store Registry Credentials In Platform Credential Stores

**Files:**
- Create: `packages/updater/src/credentials/credential-store.ts`
- Create: `packages/updater/src/credentials/windows-credential-store.ts`
- Create: `packages/updater/src/credentials/macos-keychain-store.ts`
- Create: `packages/updater/native/macos-keychain/main.swift`
- Create: `packages/updater/src/credentials/linux-secret-service-store.ts`
- Create: `packages/updater/src/credentials/index.ts`
- Create: `packages/updater/tests/credential-store.test.ts`

- [ ] **Step 1: Write platform contract tests first**

Define `CredentialStore.read/write/delete` and stable errors `credential_missing`, `credential_store_unavailable`, `credential_read_failed`, and `credential_write_failed`. Test command argument arrays, stdin use, bounded output, nonzero exits, and redaction.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```powershell
npm test --workspace @flowrivet/updater -- credential-store.test.ts
```

Expected: FAIL because no adapters exist.

- [ ] **Step 3: Implement Windows Credential Manager access**

Use a fixed PowerShell script invoked with `-NoProfile -NonInteractive`; pass the token through stdin only. Store a Generic Credential under `FlowRivet/GitLabPackageRegistry/<project-id>`. Never construct a PowerShell command containing token text.

- [ ] **Step 4: Implement macOS Keychain access**

Compile a small signed/notarized Swift helper in the macOS package using Security.framework. The helper accepts only operation, service, and account as arguments, reads secret bytes from stdin, and returns only stable status JSON. The TypeScript adapter invokes this packaged absolute helper path. Do not pass the token to `/usr/bin/security`, because its normal write interface places the password in argv.

- [ ] **Step 5: Implement Linux Secret Service access**

Call `secret-tool store/lookup/clear` with fixed attributes. Return `credential_store_unavailable` when `secret-tool` or a session Secret Service is absent; do not fall back to plaintext.

- [ ] **Step 6: Add adapter selection and rotation behavior**

Write the candidate credential, validate it by downloading the channel manifest, then delete the old credential reference only after validation. Keep validation injected so tests make no network calls.

- [ ] **Step 7: Re-run tests and typecheck**

Run:

```powershell
npm test --workspace @flowrivet/updater -- credential-store.test.ts
npm run typecheck --workspace @flowrivet/updater
```

Expected: PASS on all platform fixtures without modifying the real OS credential store.

- [ ] **Step 8: Commit secure credential storage**

```powershell
git add packages/updater/src/credentials packages/updater/native/macos-keychain/main.swift packages/updater/tests/credential-store.test.ts
git commit -m "feat(updater): protect registry credentials"
```

## Task 4: Download, Verify, And Stage Immutable Runtime Versions

**Files:**
- Create: `packages/updater/src/contracts/update-state.ts`
- Create: `packages/updater/src/storage/update-paths.ts`
- Create: `packages/updater/src/storage/version-store.ts`
- Create: `packages/updater/src/download/package-downloader.ts`
- Create: `packages/updater/src/download/archive-extractor.ts`
- Create: `packages/updater/tests/update-paths.test.ts`
- Create: `packages/updater/tests/version-store.test.ts`
- Create: `packages/updater/tests/package-downloader.test.ts`
- Create: `packages/updater/tests/archive-extractor.test.ts`

- [ ] **Step 1: Write cross-platform path tests**

Require user-level application data roots for Windows, macOS, and XDG Linux. Verify all resolved version, download, log, state, and pointer paths remain below the FlowRivet root.

- [ ] **Step 2: Write failing version-store tests**

Cover exclusive transaction locks, staging cleanup, atomic rename, exact `current.json`, crash recovery, current/previous preservation, delayed cleanup, path traversal rejection, disk-space preflight, and a corrupt pointer.

- [ ] **Step 3: Write failing streaming-download tests**

Cover content-length over limit, streamed body crossing limit, interrupted download, SHA-256 mismatch, exact size mismatch, cancellation, temporary-file cleanup, and successful fsync/close before staging.

- [ ] **Step 4: Write failing archive extraction tests**

Cover absolute paths, `..` traversal, Windows drive/UNC paths, duplicate entries, symbolic/hard links, special devices, excessive file count, excessive expanded bytes, compression-ratio limit, unexpected top-level files, and cleanup after partial extraction. Permit only the package layout declared by release metadata.

- [ ] **Step 5: Run focused tests and confirm failure**

Run:

```powershell
npm test --workspace @flowrivet/updater -- update-paths.test.ts version-store.test.ts package-downloader.test.ts archive-extractor.test.ts
```

Expected: FAIL because storage and downloader modules are absent.

- [ ] **Step 6: Implement atomic state and version storage**

Use JSON schema version 1 for `current.json` and `update-state.json`. Write a sibling temporary file, fsync where supported, then rename. Never modify files inside an activated version directory.

- [ ] **Step 7: Implement bounded verified download and extraction**

Hash bytes while streaming to the staging file. The expected hash comes from both channel and release manifests, which Task 2 already proved identical. Do not trust only GitLab response headers. Extract through the allowlisted archive adapter into a fresh staging directory; never invoke `tar` or an archive library without validating every entry before writing.

- [ ] **Step 8: Re-run checks**

Run:

```powershell
npm test --workspace @flowrivet/updater -- update-paths.test.ts version-store.test.ts package-downloader.test.ts archive-extractor.test.ts
npm run typecheck --workspace @flowrivet/updater
```

Expected: PASS.

- [ ] **Step 9: Commit immutable version staging**

```powershell
git add packages/updater/src/contracts/update-state.ts packages/updater/src/storage packages/updater/src/download packages/updater/tests/update-paths.test.ts packages/updater/tests/version-store.test.ts packages/updater/tests/package-downloader.test.ts packages/updater/tests/archive-extractor.test.ts
git commit -m "feat(updater): stage verified runtime versions"
```

## Task 5: Activate New Companion Versions And Roll Back Failures

**Files:**
- Create: `packages/updater/src/companion/companion-controller.ts`
- Create: `packages/updater/src/update/update-service.ts`
- Create: `packages/updater/tests/companion-controller.test.ts`
- Create: `packages/updater/tests/update-service.test.ts`
- Modify: `packages/codex-plugin/src/server/companion-instance.ts`
- Modify: `packages/codex-plugin/tests/companion-instance.test.ts`

- [ ] **Step 1: Write failing packaged-Companion controller tests**

Require the command to use `<version>/runtime/node[.exe]` plus `<version>/app/packages/codex-plugin/dist/server/index.js`, not `process.execPath`. Reuse PID/start-time/health identity checks from the developer updater through a small shared pure helper rather than importing the developer orchestrator.

- [ ] **Step 2: Write the update-state-machine failure matrix**

Test no update, channel failure, credential rejection, invalid manifest, incompatible protocol, download failure, integrity failure, successful activation, ownership refusal, new process exit, health timeout, rollback success, rollback failure, and failed-version cooldown across process restart.

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```powershell
npm test --workspace @flowrivet/updater -- companion-controller.test.ts update-service.test.ts
```

Expected: FAIL because activation orchestration does not exist.

- [ ] **Step 4: Implement Companion control with an injected process adapter**

Keep production process commands platform-specific but contract tests platform-neutral. Stop only an instance whose registry file, process start time, loopback address, `/health` product, PID, and instance ID all match.

- [ ] **Step 5: Implement the transaction ordering exactly**

```text
lock -> credentials -> channel manifest -> release manifest
-> compatibility -> download -> hash -> unpack -> package validation
-> stop verified old -> start candidate -> candidate health
-> write current pointer -> mark success -> unlock
```

On candidate failure, start `previousVersion`, verify health, preserve failure evidence, and add the target version to cooldown. Do not report success until the pointer and health agree.

- [ ] **Step 6: Preserve user data outside version directories**

Pass the existing FlowRivet config/cache paths to every runtime version. Tests must prove Provider login state, SQLite cache, notification inbox, and preferences paths do not change when the active version changes.

- [ ] **Step 7: Re-run checks**

Run:

```powershell
npm test --workspace @flowrivet/updater -- companion-controller.test.ts update-service.test.ts
npm test --workspace @flowrivet/codex-plugin -- companion-instance.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit activation and rollback**

```powershell
git add packages/updater/src/companion packages/updater/src/update/update-service.ts packages/updater/tests/companion-controller.test.ts packages/updater/tests/update-service.test.ts packages/codex-plugin/src/server/companion-instance.ts packages/codex-plugin/tests/companion-instance.test.ts
git commit -m "feat(updater): activate and roll back companion releases"
```

## Task 6: Run Updates In The Background And Register User Startup

**Files:**
- Create: `packages/updater/src/update/update-scheduler.ts`
- Create: `packages/updater/src/startup/startup-manager.ts`
- Create: `packages/updater/src/startup/windows-task-scheduler.ts`
- Create: `packages/updater/src/startup/macos-launch-agent.ts`
- Create: `packages/updater/src/startup/linux-systemd-user.ts`
- Create: `packages/updater/src/cli.ts`
- Create: `packages/updater/src/index.ts`
- Create: `packages/updater/tests/update-scheduler.test.ts`
- Create: `packages/updater/tests/startup-manager.test.ts`
- Create: `packages/updater/tests/cli.test.ts`

- [ ] **Step 1: Write scheduler tests with a fake clock**

Require one startup check, a 30-minute base interval, deterministic per-installation jitter, single-flight execution, exponential network backoff, failed-version cooldown, graceful shutdown, and no busy loop after synchronous failure.

- [ ] **Step 2: Write platform startup command tests**

Assert exact argument arrays for hidden Windows Task Scheduler logon task, macOS user LaunchAgent plist plus `launchctl`, and Linux `systemd --user`. Verify idempotent install, status, removal, and explicit unsupported behavior when user systemd is absent.

- [ ] **Step 3: Write CLI tests**

Cover `configure`, `run`, `check`, `status`, and `uninstall-startup`; JSON and human output; stable exit codes; secure token prompt; and exclusion of token, package body, identity, and task data.

- [ ] **Step 4: Run focused tests and confirm failure**

Run:

```powershell
npm test --workspace @flowrivet/updater -- update-scheduler.test.ts startup-manager.test.ts cli.test.ts
```

Expected: FAIL because scheduler and CLI are absent.

- [ ] **Step 5: Implement background lifecycle**

Start the currently selected Companion before attempting a network update. A failed update check must leave that Companion running. Handle `SIGINT`/`SIGTERM`, release the update lock, and stop only child processes owned by the updater when explicitly uninstalling.

- [ ] **Step 6: Implement startup registration**

Use absolute paths inside the fixed updater installation. Do not use shell interpolation, the current checkout, system Node.js, or mutable `PATH` lookup.

- [ ] **Step 7: Re-run checks**

Run:

```powershell
npm test --workspace @flowrivet/updater -- update-scheduler.test.ts startup-manager.test.ts cli.test.ts
npm run typecheck --workspace @flowrivet/updater
npm run build --workspace @flowrivet/updater
```

Expected: PASS.

- [ ] **Step 8: Commit background updates**

```powershell
git add packages/updater/src/update/update-scheduler.ts packages/updater/src/startup packages/updater/src/cli.ts packages/updater/src/index.ts packages/updater/tests/update-scheduler.test.ts packages/updater/tests/startup-manager.test.ts packages/updater/tests/cli.test.ts
git commit -m "feat(updater): run silent updates at user startup"
```

## Task 7: Show Runtime Update State In The MCP App

**Files:**
- Create: `packages/codex-plugin/src/ui/use-runtime-version.ts`
- Create: `packages/codex-plugin/src/ui/components/UpdateReadyNotice.tsx`
- Modify: `packages/codex-plugin/src/ui/bridge.ts`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`
- Create: `packages/codex-plugin/tests/use-runtime-version.test.tsx`

- [ ] **Step 1: Add a stable runtime-status MCP tool test**

Extend Task 1's server contract with `get_runtime_version`, returning the same schema as `/health` without PID or instance ID. Keep the tool name and schema backward compatible.

- [ ] **Step 2: Run a real Codex host capability spike before choosing the action**

Using a fixture Companion with UI versions N and N+1, record whether an MCP App calling `open_my_taskboard` causes Codex to create a newly rendered app result, and whether Companion restart causes Codex to reconnect and reload tool metadata. Store only Codex version and boolean outcomes in `docs/abf-poc/`; do not implement against undocumented behavior. If app-triggered reopen is unsupported, the notice action must show/copy the exact conversation command `重新打开 FlowRivet 看板` instead of presenting a nonfunctional reopen button.

- [ ] **Step 3: Write visibility-aware UI polling tests**

The hook records the UI version embedded at build time, checks runtime version only while visible, stops after disposal, coalesces overlapping checks, and reports `updateReady` only when the runtime advertises another compatible UI version.

- [ ] **Step 4: Write notice interaction tests**

Require concise “新版已就绪” text, a primary action backed by the verified host capability, a dismiss action, and a fallback “重启 Codex” message when a new conversation tool invocation still renders the embedded old UI version. Preserve keyboard focus and do not reload the iframe automatically.

- [ ] **Step 5: Run focused tests and confirm failure**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- use-runtime-version.test.tsx ui.test.tsx server.test.ts
```

Expected: FAIL because version status and notice behavior are absent.

- [ ] **Step 6: Implement runtime status and notice**

Use the MCP Apps bridge rather than direct loopback `fetch` from the iframe. Implement only the action proven in Step 2; do not assume the host renders nested tool calls or exposes a browser refresh API.

- [ ] **Step 7: Update the demo harness**

Add deterministic controls for same version, update available, and reopen-still-cached states so Playwright can verify the full interaction without a real update server.

- [ ] **Step 8: Run UI verification**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- use-runtime-version.test.tsx ui.test.tsx server.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
npm run test:e2e --workspace @flowrivet/codex-plugin
```

Expected: PASS; screenshots have no overlap at desktop and narrow widths.

- [ ] **Step 9: Commit the user-facing update state**

```powershell
git add packages/codex-plugin/src/ui/use-runtime-version.ts packages/codex-plugin/src/ui/components/UpdateReadyNotice.tsx packages/codex-plugin/src/ui/bridge.ts packages/codex-plugin/src/ui/App.tsx packages/codex-plugin/src/ui/styles.css packages/codex-plugin/src/ui/demo-harness.tsx packages/codex-plugin/tests/use-runtime-version.test.tsx packages/codex-plugin/tests/ui.test.tsx packages/codex-plugin/tests/server.test.ts
git commit -m "feat(taskboard): surface companion updates"
```

## Task 8: Build And Publish Self-Contained Cross-Platform Releases

**Files:**
- Create: `.gitlab-ci.yml`
- Create: `scripts/release/build-runtime-package.mjs`
- Create: `scripts/release/create-release-manifest.mjs`
- Create: `scripts/release/publish-generic-package.mjs`
- Create: `scripts/release/verify-runtime-package.mjs`
- Create: `scripts/release/runtime-checksums.json`
- Create: `tests/release-build.test.ts`
- Create: `tests/release-manifest-script.test.ts`
- Create: `tests/release-publish.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write deterministic package-layout tests**

Require `runtime/node[.exe]`, `app/packages/codex-plugin/dist`, `app/packages/updater/dist`, production dependencies, `release-metadata.json`, Node and dependency licenses, and no source maps, tests, credentials, `.git`, logs, caches, or development dependencies.

- [ ] **Step 2: Write manifest-generation tests**

Given fixture packages, require stable ordering, byte size, lowercase SHA-256, semantic tag normalization, platform identifiers, protocol version, updater minimum version, and byte-identical channel/release payloads.

- [ ] **Step 3: Write publish-transaction tests**

With a fake GitLab server, assert serial immutable uploads, successful authenticated read-back, hash verification, and channel pointer upload last. Simulate every upload failing and prove the pointer is not updated. Reject a duplicate immutable version.

- [ ] **Step 4: Run tests and confirm failure**

Run:

```powershell
npm test -- tests/release-build.test.ts tests/release-manifest-script.test.ts tests/release-publish.test.ts
```

Expected: FAIL because release scripts do not exist.

- [ ] **Step 5: Implement reproducible package assembly**

Download Node runtimes only from an administrator-configured internal mirror in CI, verify a pinned SHA-256 inventory committed with the release tooling, and never download runtimes on end-user machines. Normalize archive timestamps and ordering where the platform archive format permits.

- [ ] **Step 6: Implement transactional publishing**

Use `CI_JOB_TOKEN` for CI uploads, not the client Deploy Token. Upload to `flowrivet-runtime/<semver>`, verify through the Registry download endpoint, and finally upload `flowrivet-channel/latest/manifest.json`. Keep credentials out of command output.

- [ ] **Step 7: Add GitLab CI jobs**

Use protected `v*` tags, platform runners, test/build/package/verify/publish stages, and a shared `resource_group: flowrivet-stable-release` on publish. Fail preflight unless Generic duplicates are rejected for immutable packages and the narrow channel exception has passed the POC fixture.

- [ ] **Step 8: Run local script checks**

Run:

```powershell
npm test -- tests/release-build.test.ts tests/release-manifest-script.test.ts tests/release-publish.test.ts
npm run typecheck
npm run build
```

Expected: PASS. CI syntax validation must also pass against the target self-managed GitLab before merge.

- [ ] **Step 9: Commit release automation**

```powershell
git add .gitlab-ci.yml scripts/release tests/release-build.test.ts tests/release-manifest-script.test.ts tests/release-publish.test.ts package.json package-lock.json
git commit -m "feat(release): publish self-contained companion packages"
```

## Task 9: Install, Operate, And Validate The Complete Update Path

**Files:**
- Create: `scripts/install/install-flowrivet.ps1`
- Create: `scripts/install/install-flowrivet.sh`
- Create: `tests/installer-contract.test.ts`
- Create: `tests/e2e/internal-auto-update.test.ts`
- Create: `docs/operations/internal-auto-update.md`
- Modify: `docs/user-guide.md`
- Modify: `README.md`
- Modify: `poc.md`

- [ ] **Step 1: Write installer contract tests**

Assert user-level install paths, private runtime use, secure token stdin/prompt, credential-store write, stable plugin installation, startup registration, idempotent reinstall, status check, and uninstall behavior. Prohibit token command arguments and plaintext config.

- [ ] **Step 2: Write a hermetic updater E2E test**

Start a fake authenticated Generic Registry and a fixture old Companion, publish a valid candidate, run one updater check, and verify activation. Repeat with corrupt archive and unhealthy candidate to verify old-version continuity and rollback.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```powershell
npm test -- tests/installer-contract.test.ts tests/e2e/internal-auto-update.test.ts
```

Expected: FAIL because installers and complete wiring are absent.

- [ ] **Step 4: Implement Windows installation**

The PowerShell installer accepts non-secret GitLab URL/project/package settings as parameters, prompts securely for Deploy Token, installs the initial signed/verified package, writes the credential through the updater CLI stdin path, and registers the hidden logon task. Use `-LiteralPath` and validated install roots for every write or removal.

- [ ] **Step 5: Implement macOS/Linux installation**

The shell installer keeps secrets off argv and files, selects Keychain or Secret Service, installs the private runtime package below the user application-data root, and registers LaunchAgent or systemd user service. Exit with a stable unsupported code when Linux user systemd is unavailable.

- [ ] **Step 6: Document administrator and ordinary-user workflows**

Document GitLab Registry settings, protected tags, runner requirements, channel-pointer duplicate exception POC, Deploy Token creation/rotation/revocation, installation, logs, request IDs, rollback, cached-Codex fallback, and the separation from developer-only `npm run plugin:update`.

- [ ] **Step 7: Run the full automated suite**

Run:

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e --workspace @flowrivet/codex-plugin
git diff --check
```

Expected: PASS with no generated packages, tokens, logs, runtime downloads, or updater state tracked by Git.

- [ ] **Step 8: Perform target-GitLab POC before production release**

On the self-managed GitLab instance, record only version and boolean outcomes:

1. Generic Package Registry is enabled.
2. Deploy Token with only `read_package_registry` downloads the fixed channel pointer and an immutable file.
3. Immutable duplicate upload is rejected.
4. Only `flowrivet-channel/latest` accepts a new `manifest.json` revision.
5. Interrupted multi-file publication leaves the old channel pointer usable.
6. Object-storage redirects do not receive the Deploy Token header outside the trusted allowlist.

Do not store Token values, internal response bodies, user identity, project work items, or full credential-bearing URLs.

- [ ] **Step 9: Perform real platform acceptance**

On Windows, Linux, and macOS: install version N, connect the real Feishu account, publish N+1, wait for or trigger an update, verify new Companion health and new-board UI, exercise the “新版已就绪” action, test Codex restart fallback, then publish an unhealthy fixture and verify rollback. Confirm cache, login, preferences, and notifications survive.

- [ ] **Step 10: Commit installation and operations**

```powershell
git add scripts/install tests/installer-contract.test.ts tests/e2e/internal-auto-update.test.ts docs/operations/internal-auto-update.md docs/user-guide.md README.md poc.md
git commit -m "feat(updater): deliver internal automatic updates"
```

## Task 10: Final Review And Release Readiness

**Files:**
- Modify as required: files changed in Tasks 1-9
- Modify only if implementation disproves an assumption: `docs/superpowers/specs/2026-08-12-companion-auto-update-design.md`

- [ ] **Step 1: Run correctness, security, and maintainability review**

Review the complete diff for state-machine errors, rollback gaps, path traversal, archive extraction escapes, credential leaks, unsafe redirects, command injection, PID reuse, concurrent releases, cross-platform startup errors, and protocol incompatibility. Add a focused regression test for every blocking finding.

- [ ] **Step 2: Run the complete verification matrix again**

Run:

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e --workspace @flowrivet/codex-plugin
git diff --check
git status --short
```

Expected: all checks pass; only intentional source and documentation changes remain.

- [ ] **Step 3: Verify release hygiene**

Inspect a package from every target platform. Confirm it contains the pinned private Node runtime and licenses, excludes secrets and development files, starts without system Node.js, reports the tag version, and can be deleted without touching shared user data.

- [ ] **Step 4: Verify Codex host behavior explicitly**

Record whether the supported Codex desktop build reconnects to Companion and reloads versioned tool metadata without restarting. If not, keep the fallback message and update documentation; do not weaken or work around the host cache by mutating the stable plugin shell during silent updates.

- [ ] **Step 5: Commit review fixes separately**

```powershell
git add path/to/each/reviewed-file
git commit -m "fix(updater): address release readiness findings"
```

Skip the commit when review produces no changes.

## Definition Of Done

- Ordinary users install once and do not need Git, Node.js, npm, or the source checkout.
- A read-only Deploy Token is stored only in the operating-system credential store.
- The updater resolves a fixed stable channel pointer, verifies an immutable release, and never depends on generic GitLab package discovery APIs.
- Companion and UI packages activate only after hash, layout, protocol, process identity, and health checks pass.
- Failed updates leave the current Companion available or automatically restore the previous successful version.
- The stable Codex plugin shell and fixed loopback MCP endpoint remain unchanged during ordinary updates.
- New MCP sessions receive a versioned UI resource; open boards show a non-destructive update-ready flow.
- GitLab publication is serialized and cannot expose a partially uploaded release through the stable pointer.
- Windows, Linux, and macOS installation, startup, update, rollback, and uninstall contracts pass.
- Real target-GitLab and real Codex acceptance results are recorded without credentials or business data.
