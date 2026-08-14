// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoRefresh } from "../src/ui/use-auto-refresh.js";

let visibility: DocumentVisibilityState;

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAutoRefresh", () => {
  it.each([5, 10, 30, 60, 137])(
    "waits the configured %s second interval before refreshing",
    async (intervalSeconds) => {
    const performRefresh = vi.fn().mockResolvedValue({});
    renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds,
      performRefresh,
    }));

    await act(() => vi.advanceTimersByTimeAsync(intervalSeconds * 1000 - 1));
    expect(performRefresh).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(performRefresh).toHaveBeenCalledWith("automatic");
    },
  );

  it("does not schedule when refresh is off or preferences are loading", async () => {
    const performRefresh = vi.fn().mockResolvedValue({});
    const { rerender } = renderHook(({ intervalSeconds }) => useAutoRefresh({
      enabled: true,
      intervalSeconds,
      performRefresh,
    }), { initialProps: { intervalSeconds: undefined as number | undefined } });

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    rerender({ intervalSeconds: 0 });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(performRefresh).not.toHaveBeenCalled();
  });

  it("starts a full interval after the saved preference changes", async () => {
    const performRefresh = vi.fn().mockResolvedValue({});
    const { rerender } = renderHook(({ intervalSeconds }) => useAutoRefresh({
      enabled: true,
      intervalSeconds,
      performRefresh,
    }), { initialProps: { intervalSeconds: 60 } });

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    rerender({ intervalSeconds: 5 });
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(performRefresh).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(performRefresh).toHaveBeenCalledOnce();
  });

  it("coalesces repeated manual refreshes without changing the automatic deadline", async () => {
    let release!: () => void;
    const performRefresh = vi.fn().mockReturnValue(new Promise<{ retryAfterSeconds?: number }>(
      (resolve) => { release = () => resolve({}); },
    ));
    const { result } = renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 5,
      performRefresh,
    }));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.requestRefresh();
      second = result.current.requestRefresh();
    });
    expect(second).toBe(first);
    expect(performRefresh).toHaveBeenCalledWith("manual");
    await act(async () => release());
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(performRefresh).toHaveBeenCalledTimes(2);
    expect(performRefresh).toHaveBeenLastCalledWith("automatic");
  });

  it("coalesces repeated automatic refreshes by mode", async () => {
    const refresh = deferred<{ retryAfterSeconds?: number }>();
    const performRefresh = vi.fn().mockReturnValue(refresh.promise);
    const { result } = renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 5,
      performRefresh,
    }));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.requestRefresh("automatic");
      second = result.current.requestRefresh("automatic");
    });

    expect(second).toBe(first);
    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(performRefresh).toHaveBeenCalledWith("automatic");
    await act(async () => refresh.resolve({}));
  });

  it("forwards a manual click while an automatic refresh is in flight", async () => {
    const automatic = deferred<{ retryAfterSeconds?: number }>();
    const manual = deferred<{ retryAfterSeconds?: number }>();
    const performRefresh = vi.fn((mode: "manual" | "automatic") => (
      mode === "automatic" ? automatic.promise : manual.promise
    ));
    const { result } = renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 5,
      performRefresh,
    }));

    act(() => {
      void result.current.requestRefresh("automatic");
      void result.current.requestRefresh();
    });

    expect(performRefresh.mock.calls.map(([mode]) => mode))
      .toEqual(["automatic", "manual"]);
    expect(result.current.pending).toBe(true);
    await act(async () => automatic.resolve({}));
    expect(result.current.pending).toBe(true);
    await act(async () => manual.resolve({}));
    expect(result.current.pending).toBe(false);
  });

  it("forwards a timer tick while a manual refresh is in flight", async () => {
    const manual = deferred<{ retryAfterSeconds?: number }>();
    const automatic = deferred<{ retryAfterSeconds?: number }>();
    const performRefresh = vi.fn((mode: "manual" | "automatic") => (
      mode === "manual" ? manual.promise : automatic.promise
    ));
    const { result } = renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 5,
      performRefresh,
    }));

    act(() => { void result.current.requestRefresh(); });
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(performRefresh.mock.calls.map(([mode]) => mode))
      .toEqual(["manual", "automatic"]);
    expect(result.current.pending).toBe(true);
    await act(async () => manual.resolve({}));
    expect(result.current.pending).toBe(true);
    await act(async () => automatic.resolve({}));
    expect(result.current.pending).toBe(false);
  });

  it("reschedules the timer only after the automatic refresh settles", async () => {
    const automatic = deferred<{ retryAfterSeconds?: number }>();
    const nextAutomatic = deferred<{ retryAfterSeconds?: number }>();
    const performRefresh = vi.fn()
      .mockReturnValueOnce(automatic.promise)
      .mockReturnValueOnce(nextAutomatic.promise);
    renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 5,
      performRefresh,
    }));

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(performRefresh).toHaveBeenCalledTimes(1);

    await act(async () => automatic.resolve({}));
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(performRefresh).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(performRefresh).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and refreshes on visibility only after the interval elapsed", async () => {
    const performRefresh = vi.fn().mockResolvedValue({});
    renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 5,
      performRefresh,
    }));

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(performRefresh).not.toHaveBeenCalled();
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(performRefresh).toHaveBeenCalledWith("automatic");
  });

  it("uses the longer provider cooldown after partial and full rate limits", async () => {
    const performRefresh = vi.fn()
      .mockResolvedValueOnce({ retryAfterSeconds: 30 })
      .mockRejectedValueOnce(new Error("provider_rate_limited"))
      .mockResolvedValue({});
    const { result } = renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 5,
      performRefresh,
    }));

    await act(() => result.current.requestRefresh("automatic"));
    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(performRefresh).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(performRefresh).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(59_999));
    expect(performRefresh).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(performRefresh).toHaveBeenCalledTimes(3);
  });

  it("waits one configured interval after an ordinary failure", async () => {
    const performRefresh = vi.fn()
      .mockRejectedValueOnce(new Error("provider_unavailable"))
      .mockResolvedValue({});
    const { result } = renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 5,
      performRefresh,
    }));

    await act(() => result.current.requestRefresh("automatic").catch(() => undefined));
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(performRefresh).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(performRefresh).toHaveBeenCalledTimes(2);
  });

  it("allows the same mode to retry after its rejected Promise settles", async () => {
    const performRefresh = vi.fn()
      .mockRejectedValueOnce(new Error("provider_unavailable"))
      .mockResolvedValueOnce({});
    const { result } = renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 0,
      performRefresh,
    }));

    await act(() => result.current.requestRefresh().catch(() => undefined));
    await act(() => result.current.requestRefresh());

    expect(performRefresh.mock.calls.map(([mode]) => mode)).toEqual(["manual", "manual"]);
  });

  it("pauses while disconnected and restarts from a completed reconnect", async () => {
    const performRefresh = vi.fn().mockResolvedValue({});
    const { result, rerender } = renderHook(({ enabled }) => useAutoRefresh({
      enabled,
      intervalSeconds: 5,
      performRefresh,
    }), { initialProps: { enabled: false } });

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(performRefresh).not.toHaveBeenCalled();
    rerender({ enabled: true });
    act(() => result.current.markAttemptCompleted());
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(performRefresh).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(performRefresh).toHaveBeenCalledOnce();
  });

  it("cleans up its timer and visibility listener on unmount", () => {
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderHook(() => useAutoRefresh({
      enabled: true,
      intervalSeconds: 5,
      performRefresh: vi.fn().mockResolvedValue({}),
    }));

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(clearTimeout).toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
