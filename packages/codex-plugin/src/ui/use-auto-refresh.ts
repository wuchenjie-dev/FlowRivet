import { useCallback, useEffect, useRef, useState } from "react";

export interface AutoRefreshOutcome {
  retryAfterSeconds?: number;
}

export type RefreshMode = "manual" | "automatic";

export interface UseAutoRefreshOptions {
  enabled: boolean;
  intervalSeconds: number | undefined;
  performRefresh: (mode: RefreshMode) => Promise<AutoRefreshOutcome>;
}

export function useAutoRefresh({
  enabled,
  intervalSeconds,
  performRefresh,
}: UseAutoRefreshOptions) {
  const [pending, setPending] = useState(false);
  const [manualPending, setManualPending] = useState(false);
  const mounted = useRef(false);
  const enabledRef = useRef(enabled);
  const intervalRef = useRef(intervalSeconds);
  const previousIntervalRef = useRef<number | undefined>(undefined);
  const performRefreshRef = useRef(performRefresh);
  const timerRef = useRef<number | undefined>(undefined);
  const lastAttemptCompletedAtRef = useRef<number | undefined>(undefined);
  const rateLimitUntilRef = useRef<number | undefined>(undefined);
  const inFlightRef = useRef<Partial<Record<RefreshMode, Promise<void>>>>({});
  const activeModesRef = useRef(new Set<RefreshMode>());
  const scheduleRef = useRef<() => void>(() => undefined);

  enabledRef.current = enabled;
  intervalRef.current = intervalSeconds;
  performRefreshRef.current = performRefresh;

  const clearTimer = useCallback(() => {
    if (timerRef.current === undefined) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const requestRefresh = useCallback((mode: RefreshMode = "manual"): Promise<void> => {
    const current = inFlightRef.current[mode];
    if (current) return current;
    if (mode === "automatic") clearTimer();
    activeModesRef.current.add(mode);
    if (mounted.current) {
      setPending(true);
      if (mode === "manual") setManualPending(true);
    }

    let refresh: Promise<AutoRefreshOutcome>;
    try {
      refresh = performRefreshRef.current(mode);
    } catch (error) {
      refresh = Promise.reject(error);
    }
    const operation = refresh
      .then((outcome) => {
        if (mode === "automatic") {
          rateLimitUntilRef.current = outcome.retryAfterSeconds === undefined
            ? undefined
            : performance.now() + outcome.retryAfterSeconds * 1000;
        }
      })
      .catch((error: unknown) => {
        if (mode === "automatic") {
          rateLimitUntilRef.current = isRateLimitError(error)
            ? performance.now() + 60_000
            : undefined;
        }
        throw error;
      })
      .finally(() => {
        delete inFlightRef.current[mode];
        activeModesRef.current.delete(mode);
        if (mounted.current) {
          setPending(activeModesRef.current.size > 0);
          if (mode === "manual") setManualPending(false);
        }
        if (mode === "automatic") {
          lastAttemptCompletedAtRef.current = performance.now();
          scheduleRef.current();
        }
      });
    inFlightRef.current[mode] = operation;
    return operation;
  }, [clearTimer]);

  scheduleRef.current = () => {
    clearTimer();
    const interval = intervalRef.current;
    if (!mounted.current
      || !enabledRef.current
      || interval === undefined
      || interval === 0
      || document.visibilityState !== "visible"
      || inFlightRef.current.automatic) return;

    const now = performance.now();
    lastAttemptCompletedAtRef.current ??= now;
    const intervalDeadline = lastAttemptCompletedAtRef.current + interval * 1000;
    const deadline = Math.max(intervalDeadline, rateLimitUntilRef.current ?? 0);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      void requestRefresh("automatic").catch(() => undefined);
    }, Math.max(0, deadline - now));
  };

  const markAttemptCompleted = useCallback((outcome: AutoRefreshOutcome = {}) => {
    const now = performance.now();
    lastAttemptCompletedAtRef.current = now;
    rateLimitUntilRef.current = outcome.retryAfterSeconds === undefined
      ? undefined
      : now + outcome.retryAfterSeconds * 1000;
    scheduleRef.current();
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRef.current();
      else clearTimer();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    scheduleRef.current();
    return () => {
      mounted.current = false;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [clearTimer]);

  useEffect(() => {
    if (previousIntervalRef.current !== intervalSeconds) {
      lastAttemptCompletedAtRef.current = intervalSeconds === undefined || intervalSeconds === 0
        ? undefined
        : performance.now();
      previousIntervalRef.current = intervalSeconds;
    }
    scheduleRef.current();
  }, [enabled, intervalSeconds]);

  return { requestRefresh, markAttemptCompleted, pending, manualPending };
}

function isRateLimitError(error: unknown) {
  return error instanceof Error && error.message.includes("provider_rate_limited");
}
