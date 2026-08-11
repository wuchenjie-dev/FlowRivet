import {
  providerLoginSnapshotSchema,
  type ProviderLoginError,
  type ProviderLoginErrorCode,
  type ProviderLoginRecoveryAction,
  type ProviderLoginSnapshot,
  type ProviderLoginState,
} from "../contracts/providers.js";
import type {
  ProviderLoginOperationLogger,
  ProviderLoginToolName,
} from "../observability/provider-login-operation-logger.js";
import type { ProviderLoginDriver } from "./provider-login-driver.js";
import type { BrowserLaunchResult } from "./system-browser-launcher.js";

const activeStates = new Set<ProviderLoginState>([
  "starting", "waiting", "verifying",
]);
const sessionLimitMs = 5 * 60 * 1_000;
const terminalRetentionMs = 10 * 60 * 1_000;

interface BrowserLauncher {
  open(url: string, allowedHosts: readonly string[]): Promise<BrowserLaunchResult>;
}

interface LoginRecord {
  snapshot: ProviderLoginSnapshot;
  correlationId: string;
  profileName?: string;
  driver: ProviderLoginDriver;
  controller: AbortController;
  attempt?: unknown;
  verificationUriComplete?: string;
  userCode?: string;
  intervalMs?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  pollTimer?: ReturnType<typeof setTimeout>;
  retentionTimer?: ReturnType<typeof setTimeout>;
  ready: Promise<ProviderLoginSnapshot>;
  retryCount: number;
}

export type ProviderLoginCoordinatorErrorCode =
  | "provider_capability_unsupported"
  | "provider_login_session_not_found";

export class ProviderLoginCoordinatorError extends Error {
  constructor(readonly code: ProviderLoginCoordinatorErrorCode) {
    super(code);
    this.name = "ProviderLoginCoordinatorError";
  }
}

export class ProviderLoginCoordinator {
  private readonly records = new Map<string, LoginRecord>();
  private readonly resolveDriver: (providerId: string) => ProviderLoginDriver | undefined;
  private readonly browserLauncher: BrowserLauncher;
  private readonly logger: ProviderLoginOperationLogger;
  private readonly clock: () => Date;
  private readonly createSessionId: () => string;
  private readonly createCorrelationId: () => string;

  constructor(options: {
    resolveDriver: (providerId: string) => ProviderLoginDriver | undefined;
    browserLauncher: BrowserLauncher;
    logger: ProviderLoginOperationLogger;
    clock?: () => Date;
    sessionId?: () => string;
    correlationId?: () => string;
  }) {
    this.resolveDriver = options.resolveDriver;
    this.browserLauncher = options.browserLauncher;
    this.logger = options.logger;
    this.clock = options.clock ?? (() => new Date());
    this.createSessionId = options.sessionId ?? (() => crypto.randomUUID());
    this.createCorrelationId = options.correlationId ?? (() => crypto.randomUUID());
  }

  async start(providerId: string, requestId: string): Promise<ProviderLoginSnapshot> {
    const current = this.records.get(providerId);
    if (current && activeStates.has(current.snapshot.state)) {
      return current.snapshot.state === "starting"
        ? current.ready
        : cloneSnapshot(current.snapshot);
    }
    if (current) this.removeRecord(providerId, current);

    const driver = this.resolveDriver(providerId);
    if (!driver) {
      throw new ProviderLoginCoordinatorError("provider_capability_unsupported");
    }
    const now = this.clock();
    let resolveReady!: (snapshot: ProviderLoginSnapshot) => void;
    const ready = new Promise<ProviderLoginSnapshot>((resolve) => {
      resolveReady = resolve;
    });
    const record: LoginRecord = {
      snapshot: providerLoginSnapshotSchema.parse({
        sessionId: this.createSessionId(),
        providerId,
        state: "starting",
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + sessionLimitMs).toISOString(),
        browserLaunch: "opened",
      }),
      correlationId: this.createCorrelationId(),
      driver,
      controller: new AbortController(),
      ready,
      retryCount: 0,
    };
    this.records.set(providerId, record);
    this.scheduleExpiry(record, requestId);
    void this.initialize(record, requestId).then(resolveReady);
    return ready;
  }

  get(providerId: string): ProviderLoginSnapshot | undefined {
    const record = this.records.get(providerId);
    return record ? cloneSnapshot(record.snapshot) : undefined;
  }

  async reopen(
    providerId: string,
    sessionId: string,
    requestId: string,
  ): Promise<ProviderLoginSnapshot> {
    const record = this.requireActive(providerId, sessionId);
    if (!record.verificationUriComplete) {
      throw new ProviderLoginCoordinatorError("provider_login_session_not_found");
    }
    const result = await this.browserLauncher.open(
      record.verificationUriComplete,
      record.driver.allowedBrowserHosts,
    );
    this.updateBrowserResult(record, result, requestId);
    this.log(record, requestId, "reopen_provider_login", "success");
    return cloneSnapshot(record.snapshot);
  }

  async cancel(
    providerId: string,
    sessionId: string,
    requestId: string,
  ): Promise<ProviderLoginSnapshot> {
    const record = this.requireActive(providerId, sessionId);
    this.finish(record, "cancelled", requestId, "provider_login_cancelled");
    this.log(record, requestId, "cancel_provider_login", "success");
    return cloneSnapshot(record.snapshot);
  }

  private async initialize(
    record: LoginRecord,
    requestId: string,
  ): Promise<ProviderLoginSnapshot> {
    try {
      record.profileName = await record.driver.captureProfile();
      const initialized = await record.driver.initialize(
        record.profileName,
        record.controller.signal,
      );
      record.attempt = initialized.attempt;
      record.verificationUriComplete = initialized.verificationUriComplete;
      record.userCode = initialized.userCode;
      record.intervalMs = initialized.intervalMs;
      const maximumExpiry = this.clock().getTime() + sessionLimitMs;
      const driverExpiry = new Date(initialized.expiresAt).getTime();
      record.snapshot = {
        ...record.snapshot,
        expiresAt: new Date(Math.min(maximumExpiry, driverExpiry)).toISOString(),
      };
      this.scheduleExpiry(record, requestId);
      const browserResult = await this.browserLauncher.open(
        initialized.verificationUriComplete,
        record.driver.allowedBrowserHosts,
      );
      this.transition(record, "waiting", requestId, "start_provider_login");
      this.updateBrowserResult(record, browserResult, requestId);
      this.schedulePoll(record, requestId);
    } catch (error) {
      if (activeStates.has(record.snapshot.state)) {
        const mapped = mapError(error);
        this.finish(record, "failed", requestId, mapped.code, mapped);
      }
    }
    return cloneSnapshot(record.snapshot);
  }

  private schedulePoll(record: LoginRecord, requestId: string) {
    if (!record.intervalMs || !activeStates.has(record.snapshot.state)) return;
    clearTimeout(record.pollTimer);
    record.pollTimer = setTimeout(() => {
      void this.poll(record, requestId);
    }, record.intervalMs);
  }

  private async poll(record: LoginRecord, requestId: string) {
    if (record.snapshot.state !== "waiting"
      || !record.profileName
      || record.attempt === undefined) return;
    try {
      const result = await record.driver.poll(
        record.profileName,
        record.attempt,
        record.controller.signal,
      );
      if (record.snapshot.state !== "waiting") return;
      if (result.state === "pending") {
        record.retryCount += 1;
        this.log(record, requestId, "provider_login_poll", "success");
        this.schedulePoll(record, requestId);
        return;
      }
      if (result.state === "expired") {
        this.finish(record, "expired", requestId, "provider_login_expired");
        return;
      }
      if (result.state === "denied") {
        this.finish(record, "failed", requestId, "provider_login_denied");
        return;
      }
      this.transition(record, "verifying", requestId, "provider_login_poll");
      try {
        await record.driver.verifyIdentity(record.profileName);
      } catch {
        if (hasState(record, "verifying")) {
          this.finish(
            record,
            "failed",
            requestId,
            "provider_identity_validation_failed",
            {
              code: "provider_identity_validation_failed",
              retryable: true,
              recoveryAction: "recheck_connection",
            },
          );
        }
        return;
      }
      if (hasState(record, "verifying")) {
        this.finish(record, "succeeded", requestId);
      }
    } catch (error) {
      if (!activeStates.has(record.snapshot.state) || record.controller.signal.aborted) return;
      const mapped = mapError(error);
      this.finish(record, "failed", requestId, mapped.code, mapped);
    }
  }

  private scheduleExpiry(record: LoginRecord, requestId: string) {
    clearTimeout(record.expiryTimer);
    const delay = Math.max(
      0,
      new Date(record.snapshot.expiresAt).getTime() - this.clock().getTime(),
    );
    record.expiryTimer = setTimeout(() => {
      if (activeStates.has(record.snapshot.state)) {
        this.finish(record, "expired", requestId, "provider_login_expired");
      }
    }, delay);
  }

  private finish(
    record: LoginRecord,
    state: Exclude<ProviderLoginState, "starting" | "waiting" | "verifying">,
    requestId: string,
    code?: ProviderLoginErrorCode,
    mapped?: MappedError,
  ) {
    if (!activeStates.has(record.snapshot.state)) return;
    clearTimeout(record.pollTimer);
    clearTimeout(record.expiryTimer);
    record.controller.abort();
    const attempt = record.attempt;
    record.attempt = undefined;
    record.verificationUriComplete = undefined;
    record.userCode = undefined;
    if (attempt !== undefined) void record.driver.dispose(attempt);
    const error = code ? loginError(code, requestId, mapped) : undefined;
    this.transition(record, state, requestId, "provider_login_poll", error);
    record.retentionTimer = setTimeout(() => {
      if (this.records.get(record.snapshot.providerId) === record) {
        this.records.delete(record.snapshot.providerId);
      }
    }, terminalRetentionMs);
  }

  private updateBrowserResult(
    record: LoginRecord,
    result: BrowserLaunchResult,
    requestId: string,
  ) {
    const updatedAt = this.clock().toISOString();
    if (result === "opened") {
      const { error: _error, manualFallback: _fallback, ...snapshot } = record.snapshot;
      record.snapshot = providerLoginSnapshotSchema.parse({
        ...snapshot,
        browserLaunch: "opened",
        updatedAt,
      });
      return;
    }
    record.snapshot = providerLoginSnapshotSchema.parse({
      ...record.snapshot,
      browserLaunch: "manual_required",
      updatedAt,
      error: loginError("provider_browser_launch_failed", requestId),
      manualFallback: {
        verificationUri: record.verificationUriComplete,
        userCode: record.userCode,
      },
    });
  }

  private transition(
    record: LoginRecord,
    state: ProviderLoginState,
    requestId: string,
    tool: ProviderLoginToolName,
    error?: ProviderLoginError,
  ) {
    const fromState = record.snapshot.state;
    const { manualFallback: _fallback, error: _error, ...snapshot } = record.snapshot;
    record.snapshot = providerLoginSnapshotSchema.parse({
      ...snapshot,
      state,
      updatedAt: this.clock().toISOString(),
      ...(error ? { error } : {}),
    });
    this.log(record, requestId, tool, error ? "error" : "success", {
      fromState,
      toState: state,
      ...(error ? { errorCode: error.code } : {}),
    });
  }

  private requireActive(providerId: string, sessionId: string) {
    const record = this.records.get(providerId);
    if (!record
      || record.snapshot.sessionId !== sessionId
      || !activeStates.has(record.snapshot.state)) {
      throw new ProviderLoginCoordinatorError("provider_login_session_not_found");
    }
    return record;
  }

  private removeRecord(providerId: string, record: LoginRecord) {
    clearTimeout(record.expiryTimer);
    clearTimeout(record.pollTimer);
    clearTimeout(record.retentionTimer);
    this.records.delete(providerId);
  }

  private log(
    record: LoginRecord,
    requestId: string,
    tool: ProviderLoginToolName,
    outcome: "success" | "error",
    metadata: {
      fromState?: ProviderLoginState;
      toState?: ProviderLoginState;
      errorCode?: ProviderLoginErrorCode;
    } = {},
  ) {
    this.logger.log({
      requestId,
      correlationId: record.correlationId,
      tool,
      providerId: record.snapshot.providerId,
      ...metadata,
      outcome,
      durationMs: Math.max(
        0,
        this.clock().getTime() - new Date(record.snapshot.startedAt).getTime(),
      ),
      retryCount: record.retryCount,
    });
  }
}

interface MappedError {
  code: ProviderLoginErrorCode;
  retryable: boolean;
  recoveryAction: ProviderLoginRecoveryAction;
}

function mapError(error: unknown): MappedError {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  switch (code) {
    case "provider_cli_missing":
      return { code, retryable: true, recoveryAction: "install_cli" };
    case "provider_cli_unsupported":
      return { code, retryable: true, recoveryAction: "upgrade_cli" };
    case "provider_timeout":
    case "provider_unavailable":
      return { code, retryable: true, recoveryAction: "recheck_connection" };
    case "provider_not_connected":
    case "provider_unauthorized":
      return { code, retryable: true, recoveryAction: "retry_login" };
    case "provider_contract_invalid":
      return { code, retryable: false, recoveryAction: "none" };
    default:
      return {
        code: "provider_login_failed",
        retryable: true,
        recoveryAction: "retry_login",
      };
  }
}

function loginError(
  code: ProviderLoginErrorCode,
  requestId: string,
  mapped?: MappedError,
): ProviderLoginError {
  const defaults = recoveryFor(code);
  return {
    code,
    retryable: mapped?.retryable ?? defaults.retryable,
    recoveryAction: mapped?.recoveryAction ?? defaults.recoveryAction,
    requestId,
  };
}

function recoveryFor(code: ProviderLoginErrorCode): {
  retryable: boolean;
  recoveryAction: ProviderLoginRecoveryAction;
} {
  switch (code) {
    case "provider_browser_launch_failed":
      return { retryable: true, recoveryAction: "open_manually" };
    case "provider_login_cancelled":
      return { retryable: true, recoveryAction: "retry_login" };
    case "provider_login_expired":
    case "provider_login_denied":
    case "provider_login_failed":
      return { retryable: true, recoveryAction: "retry_login" };
    default:
      return { retryable: false, recoveryAction: "none" };
  }
}

function cloneSnapshot(snapshot: ProviderLoginSnapshot): ProviderLoginSnapshot {
  return providerLoginSnapshotSchema.parse(snapshot);
}

function hasState(record: LoginRecord, state: ProviderLoginState): boolean {
  return record.snapshot.state === state;
}
