// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRuntimeVersion } from "../src/ui/use-runtime-version.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("useRuntimeVersion", () => {
  it("reports a compatible newer UI and stops after disposal", async () => {
    const callTool = vi.fn(async () => ({ structuredContent: { version: "0.2.0", protocolVersion: 1, uiVersion: "0.2.0" } }));
    const { result, unmount } = renderHook(() => useRuntimeVersion({
      bridge: { callTool }, embeddedUiVersion: "0.1.0", protocolVersion: 1, intervalMs: 1000,
    }));
    await waitFor(() => expect(result.current.updateReady).toBe(true));
    unmount();
    const calls = callTool.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(callTool).toHaveBeenCalledTimes(calls);
  });

  it("does not check while the document is hidden", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const callTool = vi.fn();
    renderHook(() => useRuntimeVersion({ bridge: { callTool }, embeddedUiVersion: "0.1.0", protocolVersion: 1 }));
    await act(async () => undefined);
    expect(callTool).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
});
