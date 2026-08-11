import { useCallback, useEffect, useRef, useState } from "react";

import {
  providerLoginLookupResultSchema,
  providerLoginToolResultSchema,
  type ProviderLoginErrorCode,
  type ProviderLoginSnapshot,
} from "../contracts/providers.js";

type LoginAction = "starting" | "reopening" | "cancelling";

interface ProviderLoginBridge {
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
}

interface UseProviderLoginOptions {
  bridge: ProviderLoginBridge;
  providerId: string;
  enabled: boolean;
  onSucceeded: () => void | Promise<void>;
  pollIntervalMs?: number;
  longWaitMs?: number;
}

export interface ProviderLoginController {
  session?: ProviderLoginSnapshot;
  action?: LoginAction;
  errorCode?: ProviderLoginErrorCode;
  waitingLong: boolean;
  start(): Promise<void>;
  reopen(): Promise<void>;
  cancel(): Promise<void>;
  clear(): void;
}

const activeStates = new Set<ProviderLoginSnapshot["state"]>([
  "starting",
  "waiting",
  "verifying",
]);

function structuredContent(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("structuredContent" in result)) {
    return undefined;
  }
  return result.structuredContent;
}

export function useProviderLogin({
  bridge,
  providerId,
  enabled,
  onSucceeded,
  pollIntervalMs = 1_500,
  longWaitMs = 15_000,
}: UseProviderLoginOptions): ProviderLoginController {
  const [session, setSession] = useState<ProviderLoginSnapshot>();
  const [action, setAction] = useState<LoginAction>();
  const [errorCode, setErrorCode] = useState<ProviderLoginErrorCode>();
  const [waitingLong, setWaitingLong] = useState(false);
  const sessionRef = useRef(session);
  const mountedRef = useRef(true);
  const requestSequence = useRef(0);
  const pollPendingSequence = useRef<number | undefined>(undefined);
  const succeededSessionId = useRef<string | undefined>(undefined);
  const onSucceededRef = useRef(onSucceeded);

  sessionRef.current = session;
  onSucceededRef.current = onSucceeded;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequence.current += 1;
    };
  }, []);

  const recover = useCallback(async () => {
    if (!enabled || pollPendingSequence.current !== undefined) return;
    const sequence = ++requestSequence.current;
    pollPendingSequence.current = sequence;
    try {
      const result = await bridge.callTool("get_provider_login", {});
      const parsed = providerLoginLookupResultSchema.safeParse(structuredContent(result));
      if (!parsed.success) throw new Error("provider_contract_invalid");
      if (mountedRef.current && sequence === requestSequence.current) {
        setSession(parsed.data.session);
        setErrorCode(parsed.data.session?.error?.code);
      }
    } catch {
      if (mountedRef.current && sequence === requestSequence.current) {
        setErrorCode("provider_contract_invalid");
      }
    } finally {
      if (pollPendingSequence.current === sequence) pollPendingSequence.current = undefined;
    }
  }, [bridge, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void recover();
  }, [enabled, providerId, recover]);

  useEffect(() => {
    if (!enabled || !session || !activeStates.has(session.state)) return;
    const timer = window.setTimeout(() => void recover(), pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [enabled, pollIntervalMs, recover, session]);

  useEffect(() => {
    if (session?.state !== "waiting") {
      setWaitingLong(false);
      return;
    }
    const remaining = Math.max(0, Date.parse(session.startedAt) + longWaitMs - Date.now());
    if (remaining === 0) {
      setWaitingLong(true);
      return;
    }
    setWaitingLong(false);
    const timer = window.setTimeout(() => setWaitingLong(true), remaining);
    return () => window.clearTimeout(timer);
  }, [longWaitMs, session?.sessionId, session?.startedAt, session?.state]);

  useEffect(() => {
    if (session?.state !== "succeeded" || succeededSessionId.current === session.sessionId) return;
    succeededSessionId.current = session.sessionId;
    void onSucceededRef.current();
  }, [session]);

  const runAction = useCallback(async (
    nextAction: LoginAction,
    tool: string,
    arguments_: Record<string, unknown>,
  ) => {
    const sequence = ++requestSequence.current;
    pollPendingSequence.current = undefined;
    setAction(nextAction);
    setErrorCode(undefined);
    try {
      const result = await bridge.callTool(tool, arguments_);
      const parsed = providerLoginToolResultSchema.safeParse(structuredContent(result));
      if (!parsed.success) throw new Error("provider_contract_invalid");
      if (mountedRef.current && sequence === requestSequence.current) {
        setSession(parsed.data.session);
        setErrorCode(parsed.data.session.error?.code);
      }
    } catch {
      if (mountedRef.current && sequence === requestSequence.current) {
        setErrorCode("provider_contract_invalid");
      }
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setAction(undefined);
    }
  }, [bridge]);

  const start = useCallback(
    () => runAction("starting", "start_provider_login", {}),
    [runAction],
  );
  const reopen = useCallback(async () => {
    const sessionId = sessionRef.current?.sessionId;
    if (!sessionId) return;
    await runAction("reopening", "reopen_provider_login", { sessionId });
  }, [runAction]);
  const cancel = useCallback(async () => {
    const sessionId = sessionRef.current?.sessionId;
    if (!sessionId) return;
    await runAction("cancelling", "cancel_provider_login", { sessionId });
  }, [runAction]);
  const clear = useCallback(() => {
    requestSequence.current += 1;
    setSession(undefined);
    setAction(undefined);
    setErrorCode(undefined);
    setWaitingLong(false);
  }, []);

  return { session, action, errorCode, waitingLong, start, reopen, cancel, clear };
}
