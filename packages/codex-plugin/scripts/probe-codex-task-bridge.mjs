import { isMain, printProbeResult } from "./probe-runtime.mjs";

export async function probeCodexTaskBridge(options = {}) {
  const capabilities = options.hostCapabilities ?? {};
  const direct = capabilities.createTask === true
    && capabilities.openTask === true
    && capabilities.resumeTask === true;
  return {
    ok: true,
    capability: "codex_task_bridge",
    mode: direct ? "direct" : "handoff",
  };
}

if (isMain(import.meta.url)) printProbeResult(await probeCodexTaskBridge());
