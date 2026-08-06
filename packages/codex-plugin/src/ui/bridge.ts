import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult, Implementation } from "@modelcontextprotocol/sdk/types.js";

export type ToolResultListener = (result: CallToolResult) => void;

export interface McpAppsBridge {
  initialize(appInfo: Implementation): Promise<void>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<CallToolResult>;
  onToolResult(listener: ToolResultListener): () => void;
  dispose(): Promise<void>;
}

export function createMcpAppsBridge(hostWindow: Window = window.parent): McpAppsBridge {
  const listeners = new Set<ToolResultListener>();
  let app: App | undefined;
  let transport: PostMessageTransport | undefined;
  let initialization: Promise<void> | undefined;
  let disposed = false;

  return {
    initialize(appInfo) {
      if (disposed) {
        return Promise.reject(new Error("MCP Apps bridge has been disposed"));
      }
      if (initialization) {
        return initialization;
      }

      app = new App(
        appInfo,
        { availableDisplayModes: ["fullscreen"] },
        { autoResize: false, strict: true },
      );
      app.addEventListener("toolresult", (result) => {
        for (const listener of listeners) {
          listener(result);
        }
      });

      transport = new PostMessageTransport(hostWindow, hostWindow);
      initialization = app.connect(transport);
      return initialization;
    },

    async callTool(name, arguments_) {
      if (!app || !initialization) {
        throw new Error("MCP Apps bridge is not initialized");
      }
      await initialization;
      return app.callServerTool({ name, arguments: arguments_ });
    },

    onToolResult(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      await transport?.close();
    },
  };
}
