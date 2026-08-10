// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
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
    expect(performRefresh).toHaveBeenCalledOnce();
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

  it("shares one in-flight Promise and resets the deadline after manual refresh", async () => {
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
    expect(performRefresh).toHaveBeenCalledOnce();
    await act(async () => release());
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(performRefresh).toHaveBeenCalledOnce();
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
    expect(performRefresh).toHaveBeenCalledOnce();
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

    await act(() => result.current.requestRefresh());
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

    await act(() => result.current.requestRefresh().catch(() => undefined));
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(performRefresh).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(performRefresh).toHaveBeenCalledTimes(2);
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
