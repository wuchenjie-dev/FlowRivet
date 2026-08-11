// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderLoginSnapshot } from "../src/contracts/providers.js";
import { useProviderLogin } from "../src/ui/use-provider-login.js";

function session(
  state: ProviderLoginSnapshot["state"],
  overrides: Partial<ProviderLoginSnapshot> = {},
): ProviderLoginSnapshot {
  return {
    sessionId: "login-1",
    providerId: "feishu-project",
    state,
    startedAt: "2026-08-11T01:00:00.000Z",
    updatedAt: "2026-08-11T01:00:00.000Z",
    expiresAt: "2026-08-11T01:05:00.000Z",
    browserLaunch: "opened",
    ...overrides,
  };
}

describe("useProviderLogin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers an active session, polls without overlap, and reports success once", async () => {
    vi.useFakeTimers();
    const waiting = session("waiting");
    const succeeded = session("succeeded", {
      updatedAt: "2026-08-11T01:00:02.000Z",
    });
    let releasePoll!: () => void;
    const pollGate = new Promise<void>((resolve) => { releasePoll = resolve; });
    const callTool = vi.fn()
      .mockResolvedValueOnce({ structuredContent: { requestId: "req-1", session: waiting } })
      .mockImplementationOnce(async () => {
        await pollGate;
        return { structuredContent: { requestId: "req-2", session: succeeded } };
      });
    const onSucceeded = vi.fn();
    const bridge = { callTool };

    const { result } = renderHook(() => useProviderLogin({
      bridge,
      providerId: "feishu-project",
      enabled: true,
      onSucceeded,
    }));

    await act(async () => { await Promise.resolve(); });
    expect(result.current.session?.state).toBe("waiting");

    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(callTool).toHaveBeenCalledTimes(2);

    await act(async () => { vi.advanceTimersByTime(4_500); });
    expect(callTool).toHaveBeenCalledTimes(2);

    await act(async () => {
      releasePoll();
      await Promise.resolve();
    });
    expect(result.current.session?.state).toBe("succeeded");
    expect(onSucceeded).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(onSucceeded).toHaveBeenCalledTimes(1);
  });

  it("starts, reopens, and cancels the current provider session", async () => {
    const waiting = session("waiting");
    const cancelled = session("cancelled");
    const callTool = vi.fn(async (name: string) => {
      if (name === "get_provider_login") {
        return { structuredContent: { requestId: "req-get" } };
      }
      if (name === "cancel_provider_login") {
        return { structuredContent: { requestId: "req-cancel", session: cancelled } };
      }
      return { structuredContent: { requestId: `req-${name}`, session: waiting } };
    });
    const bridge = { callTool };
    const { result } = renderHook(() => useProviderLogin({
      bridge,
      providerId: "feishu-project",
      enabled: true,
      onSucceeded: vi.fn(),
    }));

    await waitFor(() => expect(callTool).toHaveBeenCalledWith("get_provider_login", {}));
    await act(async () => { await result.current.start(); });
    expect(callTool).toHaveBeenCalledWith("start_provider_login", {});

    await act(async () => { await result.current.reopen(); });
    expect(callTool).toHaveBeenCalledWith("reopen_provider_login", { sessionId: "login-1" });

    await act(async () => { await result.current.cancel(); });
    expect(callTool).toHaveBeenCalledWith("cancel_provider_login", { sessionId: "login-1" });
    expect(result.current.session?.state).toBe("cancelled");
  });

  it("does not let a stale recovery response overwrite a newly started session", async () => {
    let releaseRecovery!: (value: unknown) => void;
    const recovery = new Promise<unknown>((resolve) => { releaseRecovery = resolve; });
    const newer = session("waiting", { sessionId: "login-new" });
    const callTool = vi.fn(async (name: string) => name === "get_provider_login"
      ? recovery
      : { structuredContent: { requestId: "req-start", session: newer } });
    const bridge = { callTool };
    const { result } = renderHook(() => useProviderLogin({
      bridge,
      providerId: "feishu-project",
      enabled: true,
      onSucceeded: vi.fn(),
    }));

    await act(async () => { await result.current.start(); });
    expect(result.current.session?.sessionId).toBe("login-new");

    await act(async () => {
      releaseRecovery({ structuredContent: { requestId: "req-old" } });
      await Promise.resolve();
    });
    expect(result.current.session?.sessionId).toBe("login-new");
  });

  it("marks a waiting session as long-running after fifteen seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T01:00:00.000Z"));
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: { requestId: "req-1", session: session("waiting") },
    });
    const bridge = { callTool };
    const { result } = renderHook(() => useProviderLogin({
      bridge,
      providerId: "feishu-project",
      enabled: true,
      onSucceeded: vi.fn(),
    }));

    await act(async () => { await Promise.resolve(); });
    expect(result.current.session?.state).toBe("waiting");
    expect(result.current.waitingLong).toBe(false);

    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(result.current.waitingLong).toBe(true);
  });
});
