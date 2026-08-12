import { useEffect, useRef, useState } from "react";

import { runtimeVersionSchema } from "../contracts/runtime-version.js";

interface RuntimeVersionBridge {
  callTool(name: string, arguments_: Record<string, unknown>): Promise<{ structuredContent?: unknown }>;
}

export function useRuntimeVersion(options: {
  bridge: RuntimeVersionBridge;
  embeddedUiVersion: string;
  protocolVersion: number;
  intervalMs?: number;
}) {
  const [updateReady, setUpdateReady] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = options.intervalMs ?? 60_000;

    const schedule = () => {
      if (active && document.visibilityState === "visible") timer = setTimeout(() => { void check(); }, interval);
    };
    const check = async () => {
      if (!active || inFlight.current || document.visibilityState !== "visible") return;
      inFlight.current = true;
      try {
        const result = await options.bridge.callTool("get_runtime_version", {});
        const parsed = runtimeVersionSchema.safeParse(result.structuredContent);
        if (active && parsed.success) {
          setUpdateReady(parsed.data.protocolVersion === options.protocolVersion
            && parsed.data.uiVersion !== options.embeddedUiVersion);
        }
      } catch {
        // A failed background version check must not interrupt the taskboard.
      } finally {
        inFlight.current = false;
        schedule();
      }
    };
    const onVisibilityChange = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void check();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [options.bridge, options.embeddedUiVersion, options.intervalMs, options.protocolVersion]);

  return { updateReady };
}
