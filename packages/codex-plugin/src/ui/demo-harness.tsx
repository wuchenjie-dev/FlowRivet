import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

import type { TaskboardSnapshot } from "../contracts/taskboard.js";
import { workItemDetailRefSchema } from "../contracts/work-item-detail.js";
import {
  demoTaskboardSnapshot,
  demoWorkItemDetail,
} from "../demo/fixtures.js";

type Scenario = "connected" | "disconnected" | "expired" | "partial" | "error";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function scenarioSnapshot(scenario: Scenario): TaskboardSnapshot {
  if (scenario === "partial") {
    return {
      ...demoTaskboardSnapshot,
      syncSummary: { successfulProjects: 1, failedProjects: 1, itemCount: 7 },
    };
  }
  if (scenario === "error") {
    return {
      ...demoTaskboardSnapshot,
      items: [],
      projects: demoTaskboardSnapshot.projects.map((project) => ({ ...project, count: 0 })),
      syncSummary: { successfulProjects: 0, failedProjects: 2, itemCount: 0 },
      syncErrorCode: "work_item_sync_failed",
    };
  }
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
        content: [{ type: "text", text: "FlowRivet Phase 1C read-only board" }],
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
        const toolName = message.params?.name;
        const detailReference = workItemDetailRefSchema.safeParse(message.params?.arguments);
        const connectedSnapshot = scenarioSnapshot("connected");
        const structuredContent = toolName === "login_with_tapd_token"
          ? {
              ok: true,
              connection: {
                tapd: "connected",
                userName: connectedSnapshot.connection.userName,
                companyName: connectedSnapshot.connection.companyName,
              },
            }
          : toolName === "open_my_taskboard" || toolName === "refresh_my_work_items"
            ? scenarioSnapshot(scenario === "disconnected" || scenario === "expired"
              ? "connected"
              : scenario)
            : toolName === "disconnect_tapd"
              ? { ok: true, connection: { tapd: "disconnected" } }
              : toolName === "get_work_item_detail" && detailReference.success
                ? demoWorkItemDetail(detailReference.data)
              : undefined;
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: structuredContent ? "ok" : "pong" }],
            ...(structuredContent ? { structuredContent } : {}),
          },
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
