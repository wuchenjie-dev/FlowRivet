// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMcpAppsBridge } from "../src/ui/bridge.js";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const bridges: Array<ReturnType<typeof createMcpAppsBridge>> = [];

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
  vi.restoreAllMocks();
});

function createHost() {
  const posted: RpcMessage[] = [];
  const host = {
    postMessage(message: RpcMessage) {
      posted.push(message);
    },
  } as unknown as Window;

  const dispatch = (message: RpcMessage, source: MessageEventSource = host) => {
    window.dispatchEvent(new MessageEvent("message", { data: message, source }));
  };

  const request = async (method: string) => {
    await vi.waitFor(() => {
      expect(posted.some((message) => message.method === method)).toBe(true);
    });
    return posted.findLast((message) => message.method === method)!;
  };

  return { host, posted, dispatch, request };
}

function initializationResult(id: RpcMessage["id"]): RpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "flowrivet-test-host", version: "0.1.0" },
      hostCapabilities: { serverTools: {} },
      hostContext: {
        theme: "light",
        displayMode: "fullscreen",
        availableDisplayModes: ["fullscreen"],
      },
    },
  };
}

async function initializeBridge() {
  const host = createHost();
  const bridge = createMcpAppsBridge(host.host);
  bridges.push(bridge);
  const initializing = bridge.initialize({
    name: "flowrivet-taskboard",
    version: "0.1.0",
  });
  const request = await host.request("ui/initialize");
  host.dispatch(initializationResult(request.id));
  await initializing;
  return { bridge, ...host };
}

describe("MCP Apps bridge", () => {
  it("performs the standard initialization handshake", async () => {
    const { posted } = await initializeBridge();

    expect(posted.map((message) => message.method)).toEqual([
      "ui/initialize",
      "ui/notifications/initialized",
    ]);
    expect(posted[0]?.params).toMatchObject({
      appInfo: { name: "flowrivet-taskboard", version: "0.1.0" },
      protocolVersion: "2026-01-26",
    });
  });

  it("calls a server tool and returns structured content", async () => {
    const { bridge, dispatch, request } = await initializeBridge();
    const calling = bridge.callTool("demo_ping", { message: "hello" });
    const toolRequest = await request("tools/call");
    dispatch({
      jsonrpc: "2.0",
      id: toolRequest.id,
      result: {
        content: [],
        structuredContent: { ok: true, message: "hello" },
      },
    });

    await expect(calling).resolves.toMatchObject({
      structuredContent: { ok: true, message: "hello" },
    });
  });

  it("rejects host tool errors", async () => {
    const { bridge, dispatch, request } = await initializeBridge();
    const calling = bridge.callTool("demo_ping", {});
    const toolRequest = await request("tools/call");
    dispatch({
      jsonrpc: "2.0",
      id: toolRequest.id,
      error: { code: -32_000, message: "Companion unavailable" },
    });

    await expect(calling).rejects.toThrow("Companion unavailable");
  });

  it("subscribes to tool results and ignores other window sources", async () => {
    const { bridge, dispatch } = await initializeBridge();
    const listener = vi.fn();
    const unsubscribe = bridge.onToolResult(listener);
    const result = {
      content: [],
      structuredContent: { connection: { tapd: "connected" } },
    };
    const notification: RpcMessage = {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: result,
    };

    dispatch(notification, {} as MessageEventSource);
    dispatch(notification);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(listener).toHaveBeenCalledWith(result);

    unsubscribe();
    dispatch(notification);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).toHaveBeenCalledOnce();
  });
});
