import { useCallback, useEffect, useRef, useState } from "react";

export interface AutoRefreshOutcome {
  retryAfterSeconds?: number;
}

export interface UseAutoRefreshOptions {
  enabled: boolean;
  intervalSeconds: number | undefined;
  performRefresh: () => Promise<AutoRefreshOutcome>;
}

export function useAutoRefresh({
  enabled,
  intervalSeconds,
  performRefresh,
}: UseAutoRefreshOptions) {
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const enabledRef = useRef(enabled);
  const intervalRef = useRef(intervalSeconds);
  const performRefreshRef = useRef(performRefresh);
  const timerRef = useRef<number | undefined>(undefined);
  const lastAttemptCompletedAtRef = useRef<number | undefined>(undefined);
  const rateLimitUntilRef = useRef<number | undefined>(undefined);
  const inFlightRef = useRef<Promise<void> | undefined>(undefined);
  const scheduleRef = useRef<() => void>(() => undefined);

  enabledRef.current = enabled;
  intervalRef.current = intervalSeconds;
  performRefreshRef.current = performRefresh;

  const clearTimer = useCallback(() => {
    if (timerRef.current === undefined) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const requestRefresh = useCallback((): Promise<void> => {
    const current = inFlightRef.current;
    if (current) return current;
    if (mounted.current) setPending(true);

    let refresh: Promise<AutoRefreshOutcome>;
    try {
      refresh = performRefreshRef.current();
    } catch (error) {
      refresh = Promise.reject(error);
    }
    const operation = refresh
      .then((outcome) => {
        rateLimitUntilRef.current = outcome.retryAfterSeconds === undefined
          ? undefined
          : performance.now() + outcome.retryAfterSeconds * 1000;
      })
      .catch((error: unknown) => {
        rateLimitUntilRef.current = isRateLimitError(error)
          ? performance.now() + 60_000
          : undefined;
        throw error;
      })
      .finally(() => {
        lastAttemptCompletedAtRef.current = performance.now();
        inFlightRef.current = undefined;
        if (mounted.current) setPending(false);
        scheduleRef.current();
      });
    inFlightRef.current = operation;
    return operation;
  }, []);

  scheduleRef.current = () => {
    clearTimer();
    const interval = intervalRef.current;
    if (!mounted.current
      || !enabledRef.current
      || interval === undefined
      || interval === 0
      || document.visibilityState !== "visible"
      || inFlightRef.current) return;

    const now = performance.now();
    lastAttemptCompletedAtRef.current ??= now;
    const intervalDeadline = lastAttemptCompletedAtRef.current + interval * 1000;
    const deadline = Math.max(intervalDeadline, rateLimitUntilRef.current ?? 0);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      void requestRefresh().catch(() => undefined);
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
    scheduleRef.current();
  }, [enabled, intervalSeconds]);

  return { requestRefresh, markAttemptCompleted, pending };
}

function isRateLimitError(error: unknown) {
  return error instanceof Error && error.message.includes("provider_rate_limited");
}
