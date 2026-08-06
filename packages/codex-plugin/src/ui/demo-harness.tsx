import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

import { demoTaskboardSnapshot } from "../demo/fixtures.js";
import type { TaskboardSnapshot } from "../contracts/taskboard.js";

type Scenario = "connected" | "disconnected" | "expired";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function scenarioSnapshot(scenario: Scenario): TaskboardSnapshot {
  return {
    ...demoTaskboardSnapshot,
    connection: {
      ...demoTaskboardSnapshot.connection,
      tapd: scenario,
      userName: scenario === "disconnected" ? undefined : demoTaskboardSnapshot.connection.userName,
      companyName: scenario === "disconnected" ? undefined : demoTaskboardSnapshot.connection.companyName,
    },
  };
}

function DemoHarness() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scenario = (new URLSearchParams(location.search).get("scenario") ?? "connected") as Scenario;

  useEffect(() => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) return;

    const send = (message: JsonRpcMessage) => frameWindow.postMessage(message, "*");
    const sendSnapshot = () => send({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: [{ type: "text", text: "FlowRivet Phase 0 demo" }],
        structuredContent: scenarioSnapshot(scenario),
      },
    });

    const onMessage = (event: MessageEvent<JsonRpcMessage>) => {
      if (event.source !== frameWindow || event.data?.jsonrpc !== "2.0") return;
      const message = event.data;

      if (message.method === "ui/initialize" && message.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: String(message.params?.protocolVersion ?? "2026-01-26"),
            hostInfo: { name: "flowrivet-e2e-host", version: "0.1.0" },
            hostCapabilities: { serverTools: {} },
            hostContext: {
              theme: "light",
              displayMode: "fullscreen",
              availableDisplayModes: ["fullscreen"],
              platform: "desktop",
              locale: "zh-CN",
              timeZone: "Asia/Shanghai",
            },
          },
        });
        return;
      }

      if (message.method === "ui/notifications/initialized") {
        sendSnapshot();
        return;
      }

      if (message.method === "tools/call" && message.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "pong" }] },
        });
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [scenario]);

  return (
    <iframe
      ref={frameRef}
      title="FlowRivet MCP App"
      src="/dist/ui/taskboard.html"
      style={{ width: "100%", height: "100%", border: 0, display: "block" }}
    />
  );
}

const root = document.getElementById("harness-root");
if (!root) throw new Error("Harness root is missing");
createRoot(root).render(<DemoHarness />);
