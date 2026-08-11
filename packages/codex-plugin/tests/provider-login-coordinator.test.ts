import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderSessionIdentity } from "../src/providers/provider-auth-service.js";
import type {
  ProviderLoginDriver,
  ProviderLoginInitialization,
  ProviderLoginPollResult,
} from "../src/providers/provider-login-driver.js";
import {
  ProviderLoginCoordinator,
  ProviderLoginCoordinatorError,
} from "../src/providers/provider-login-coordinator.js";
import type { ProviderLoginOperationLogger } from "../src/observability/provider-login-operation-logger.js";

const initialization: ProviderLoginInitialization = {
  attempt: { deviceCode: "DEVICE-SECRET", clientId: "CLIENT-SECRET" },
  verificationUri: "https://open.feishu.cn/device",
  verificationUriComplete: "https://open.feishu.cn/device?code=example",
  userCode: "USER-CODE",
  expiresAt: "2026-08-11T00:10:00.000Z",
  intervalMs: 5_000,
};

class FakeDriver implements ProviderLoginDriver {
  readonly allowedBrowserHosts = ["open.feishu.cn"];
  readonly captureProfile = vi.fn(async () => "default");
  readonly initialize = vi.fn(async () => initialization);
  readonly poll = vi.fn(async (): Promise<ProviderLoginPollResult> => ({
    state: "pending",
  }));
  readonly verifyIdentity = vi.fn(async (): Promise<ProviderSessionIdentity> => ({
    profileName: "default",
    accountKey: "user-example",
    accountDisplayName: "Example User",
  }));
  readonly dispose = vi.fn(async () => undefined);
}

function setup(options: {
  driver?: FakeDriver;
  browserResults?: Array<"opened" | "manual_required">;
} = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
  const driver = options.driver ?? new FakeDriver();
  const browserResults = [...(options.browserResults ?? ["opened"])];
  const browserLauncher = {
    open: vi.fn(async () => browserResults.shift() ?? "opened" as const),
  };
  const events: unknown[] = [];
  const logger: ProviderLoginOperationLogger = {
    log: vi.fn((event) => events.push(event)),
  };
  let sessionSequence = 0;
  let correlationSequence = 0;
  const coordinator = new ProviderLoginCoordinator({
    resolveDriver: (providerId) => providerId === "feishu-project" ? driver : undefined,
    browserLauncher,
    logger,
    clock: () => new Date(Date.now()),
    sessionId: () => `session-${++sessionSequence}`,
    correlationId: () => `correlation-${++correlationSequence}`,
  });
  return { browserLauncher, coordinator, driver, events, logger };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("provider login coordinator", () => {
  it("reuses one active provider session and reaches succeeded automatically", async () => {
    const driver = new FakeDriver();
    driver.poll.mockResolvedValueOnce({ state: "authorized" });
    const { coordinator, events } = setup({ driver });

    const first = await coordinator.start("feishu-project", "request-1");
    const second = await coordinator.start("feishu-project", "request-2");

    expect(second.sessionId).toBe(first.sessionId);
    expect(first.state).toBe("waiting");
    expect(driver.initialize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(coordinator.get("feishu-project")).toMatchObject({ state: "succeeded" });
    expect(driver.verifyIdentity).toHaveBeenCalledWith("default");
    expect(driver.dispose).toHaveBeenCalledWith(initialization.attempt);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ toState: "waiting" }),
      expect.objectContaining({ toState: "verifying" }),
      expect.objectContaining({ toState: "succeeded" }),
    ]));
  });

  it("exposes fallback only after browser failure and clears it after reopen", async () => {
    const { browserLauncher, coordinator } = setup({
      browserResults: ["manual_required", "opened"],
    });

    const waiting = await coordinator.start("feishu-project", "request-1");
    expect(waiting).toMatchObject({
      state: "waiting",
      browserLaunch: "manual_required",
      error: {
        code: "provider_browser_launch_failed",
        recoveryAction: "open_manually",
      },
      manualFallback: {
        verificationUri: initialization.verificationUriComplete,
        userCode: initialization.userCode,
      },
    });

    const reopened = await coordinator.reopen(
      "feishu-project", waiting.sessionId, "request-2",
    );
    expect(reopened.browserLaunch).toBe("opened");
    expect(reopened).not.toHaveProperty("manualFallback");
    expect(reopened).not.toHaveProperty("error");
    expect(browserLauncher.open).toHaveBeenCalledTimes(2);
    await expect(coordinator.start("feishu-project", "request-3")).resolves.toEqual(reopened);
  });

  it("cancels only the matching active session and clears private data", async () => {
    const { coordinator, driver } = setup();
    const waiting = await coordinator.start("feishu-project", "request-1");

    await expect(coordinator.cancel(
      "feishu-project", "other-session", "request-2",
    )).rejects.toBeInstanceOf(ProviderLoginCoordinatorError);
    const cancelled = await coordinator.cancel(
      "feishu-project", waiting.sessionId, "request-3",
    );

    expect(cancelled).toMatchObject({
      state: "cancelled",
      error: { code: "provider_login_cancelled" },
    });
    expect(driver.dispose).toHaveBeenCalledWith(initialization.attempt);
    expect(JSON.stringify(cancelled)).not.toMatch(/DEVICE-SECRET|CLIENT-SECRET|USER-CODE/u);
  });

  it("expires at five minutes and removes the safe terminal snapshot ten minutes later", async () => {
    const { coordinator } = setup();
    const waiting = await coordinator.start("feishu-project", "request-1");
    expect(waiting.expiresAt).toBe("2026-08-11T00:05:00.000Z");

    await vi.advanceTimersByTimeAsync(300_000);
    expect(coordinator.get("feishu-project")).toMatchObject({
      state: "expired",
      error: { code: "provider_login_expired" },
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(coordinator.get("feishu-project")).toBeUndefined();
  });

  it("maps a verified denial and a profile change to stable terminal failures", async () => {
    const deniedDriver = new FakeDriver();
    deniedDriver.poll.mockResolvedValueOnce({ state: "denied" });
    const denied = setup({ driver: deniedDriver }).coordinator;
    await denied.start("feishu-project", "request-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(denied.get("feishu-project")).toMatchObject({
      state: "failed",
      error: { code: "provider_login_denied" },
    });
    vi.useRealTimers();

    const changedDriver = new FakeDriver();
    changedDriver.poll.mockRejectedValueOnce({ code: "provider_profile_changed" });
    const changed = setup({ driver: changedDriver }).coordinator;
    await changed.start("feishu-project", "request-2");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(changed.get("feishu-project")).toMatchObject({
      state: "failed",
      error: { code: "provider_login_failed" },
    });
  });

  it("classifies post-authorization identity failures separately", async () => {
    const driver = new FakeDriver();
    driver.poll.mockResolvedValueOnce({ state: "authorized" });
    driver.verifyIdentity.mockRejectedValueOnce({ code: "provider_not_connected" });
    const { coordinator } = setup({ driver });

    await coordinator.start("feishu-project", "request-1");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(coordinator.get("feishu-project")).toMatchObject({
      state: "failed",
      error: {
        code: "provider_identity_validation_failed",
        recoveryAction: "recheck_connection",
      },
    });
  });

  it("rejects an unregistered provider without creating a session", async () => {
    const { coordinator } = setup();

    await expect(coordinator.start("missing", "request-1"))
      .rejects.toMatchObject({ code: "provider_capability_unsupported" });
    expect(coordinator.get("missing")).toBeUndefined();
  });
});
