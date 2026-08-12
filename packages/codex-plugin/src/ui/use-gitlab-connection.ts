import { useCallback, useEffect, useRef, useState } from "react";

import {
  gitLabConnectionSchema,
  gitLabLoginResultSchema,
  type GitLabConnection,
} from "../contracts/gitlab.js";
import type { McpAppsBridge } from "./bridge.js";

export function useGitLabConnection(options: {
  bridge: Pick<McpAppsBridge, "callTool">;
  enabled: boolean;
}) {
  const { bridge, enabled } = options;
  const [connection, setConnection] = useState<GitLabConnection>({
    host: "gitlab-aiabu.ruijie.com.cn",
    state: "checking",
  });
  const [pending, setPending] = useState(false);
  const [loginWaiting, setLoginWaiting] = useState(false);
  const mounted = useRef(true);

  const recheck = useCallback(async () => {
    setPending(true);
    try {
      const result = await bridge.callTool("recheck_gitlab_connection", {});
      const parsed = gitLabConnectionSchema.parse(result.structuredContent);
      if (mounted.current) {
        setConnection(parsed);
        if (parsed.state === "connected") setLoginWaiting(false);
      }
      return parsed;
    } catch {
      const fallback: GitLabConnection = {
        host: "gitlab-aiabu.ruijie.com.cn",
        state: "unavailable",
      };
      if (mounted.current) setConnection(fallback);
      return fallback;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, [bridge]);

  const startLogin = useCallback(async () => {
    setPending(true);
    try {
      const result = await bridge.callTool("start_gitlab_login", {});
      const parsed = gitLabLoginResultSchema.parse(result.structuredContent);
      if (mounted.current) setLoginWaiting(parsed.state === "waiting");
      if (parsed.state === "connected") await recheck();
    } catch {
      await recheck();
    } finally {
      if (mounted.current) setPending(false);
    }
  }, [bridge, recheck]);

  useEffect(() => {
    mounted.current = true;
    if (enabled) void recheck();
    return () => { mounted.current = false; };
  }, [enabled, recheck]);

  useEffect(() => {
    if (!enabled || !loginWaiting) return;
    const timer = window.setInterval(() => { void recheck(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [enabled, loginWaiting, recheck]);

  return { connection, pending, loginWaiting, startLogin, recheck };
}
