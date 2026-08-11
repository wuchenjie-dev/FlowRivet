import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  defaultTaskboardPreferences,
  taskboardPreferencesSchema,
} from "../contracts/taskboard-preferences.js";
import type { TaskboardSnapshot } from "../contracts/taskboard.js";
import { workItemDetailRefSchema } from "../contracts/work-item-detail.js";
import {
  demoTaskboardSnapshot,
  demoWorkItemDetail,
} from "../demo/fixtures.js";

type Scenario =
  | "connected"
  | "disconnected"
  | "cli_missing"
  | "expired"
  | "partial"
  | "error"
  | "mixed"
  | "offline"
  | "offline-detail-error";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const feishuDemoTaskboardSnapshot: TaskboardSnapshot = {
  ...demoTaskboardSnapshot,
  connection: {
    ...demoTaskboardSnapshot.connection,
    provider: {
      providerId: "feishu-project",
      displayName: "飞书项目",
      state: "connected",
      accountDisplayName: "演示用户",
      profileName: "default",
    },
  },
  projectCatalog: {
    ...demoTaskboardSnapshot.projectCatalog,
    provider: {
      providerId: "feishu-project",
      displayName: "飞书项目",
      state: "connected",
      accountDisplayName: "演示用户",
      profileName: "default",
    },
    projects: demoTaskboardSnapshot.projectCatalog.projects.map((project, index) => ({
      ...project,
      providerId: "feishu-project",
      externalId: `PROJ-${index + 1}`,
    })),
  },
  projects: demoTaskboardSnapshot.projects.map((project, index) => ({
    ...project,
    providerId: "feishu-project",
    externalId: `PROJ-${index + 1}`,
  })),
  items: demoTaskboardSnapshot.items.map((item, index) => ({
    ...item,
    key: `feishu-project:PROJ-${index % 2 + 1}:work_item:${index + 1}`,
    providerId: "feishu-project",
    projectExternalId: `PROJ-${index % 2 + 1}`,
    externalUrl: `https://project.feishu.cn/demo/work_item/${index + 1}`,
  })),
};

function scenarioSnapshot(scenario: Scenario): TaskboardSnapshot {
  if (scenario === "partial") {
    return {
      ...feishuDemoTaskboardSnapshot,
      syncSummary: { successfulProjects: 1, failedProjects: 1, itemCount: 7 },
    };
  }
  if (scenario === "error") {
    return {
      ...feishuDemoTaskboardSnapshot,
      items: [],
      projects: feishuDemoTaskboardSnapshot.projects.map((project) => ({ ...project, count: 0 })),
      syncSummary: { successfulProjects: 0, failedProjects: 2, itemCount: 0 },
      syncErrorCode: "work_item_sync_failed",
    };
  }
  if (scenario === "mixed") {
    return {
      ...feishuDemoTaskboardSnapshot,
      dataFreshness: "mixed",
      freshScopeCount: 4,
      staleScopeCount: 2,
      lastSuccessfulSyncAt: "2026-08-06T12:00:00.000Z",
      items: feishuDemoTaskboardSnapshot.items.map((item, index) => ({
        ...item,
        freshness: index < 2 ? "cached" : "fresh",
      })),
    };
  }
  if (scenario === "offline" || scenario === "offline-detail-error") {
    return {
      ...feishuDemoTaskboardSnapshot,
      connection: {
        ...feishuDemoTaskboardSnapshot.connection,
        provider: {
          ...feishuDemoTaskboardSnapshot.connection.provider,
          state: "expired",
        },
      },
      projectCatalog: {
        ...feishuDemoTaskboardSnapshot.projectCatalog,
        stale: true,
      },
      dataFreshness: "offline",
      freshScopeCount: 0,
      staleScopeCount: 6,
      lastSuccessfulSyncAt: "2026-08-06T12:00:00.000Z",
      freshnessReasonCode: "provider_unauthorized",
      items: feishuDemoTaskboardSnapshot.items.map((item) => ({
        ...item,
        freshness: "cached",
      })),
    };
  }
  return {
    ...feishuDemoTaskboardSnapshot,
    connection: {
      ...feishuDemoTaskboardSnapshot.connection,
      provider: {
        ...feishuDemoTaskboardSnapshot.connection.provider,
        state: scenario,
        ...(scenario !== "connected"
          ? { accountDisplayName: undefined, tenantDisplayName: undefined }
          : {}),
      },
    },
  };
}

function DemoHarness() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const preferencesRef = useRef({ ...defaultTaskboardPreferences });
  const [refreshCallCount, setRefreshCallCount] = useState(0);
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
        if (toolName === "get_taskboard_preferences") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: "ok" }],
              structuredContent: preferencesRef.current,
            },
          });
          return;
        }
        if (toolName === "save_taskboard_preferences") {
          const parsed = taskboardPreferencesSchema.safeParse(message.params?.arguments);
          if (!parsed.success) {
            send({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32602, message: "taskboard_preferences_write_failed" },
            });
            return;
          }
          preferencesRef.current = parsed.data;
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: "ok" }],
              structuredContent: parsed.data,
            },
          });
          return;
        }
        if (toolName === "refresh_my_work_items") {
          setRefreshCallCount((count) => count + 1);
        }
        const detailReference = workItemDetailRefSchema.safeParse(message.params?.arguments);
        if (toolName === "get_work_item_detail" && scenario === "offline-detail-error") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "provider_not_connected" },
          });
          return;
        }
        const connectedSnapshot = scenarioSnapshot("connected");
        const structuredContent = toolName === "start_provider_login"
          ? {
              transactionId: "demo-transaction",
              providerId: "feishu-project",
              verificationUri: "https://open.feishu.cn/device",
              userCode: "DEMO-CODE",
              expiresAt: "2026-08-11T16:00:00.000Z",
            }
          : toolName === "get_provider_connection"
            ? connectedSnapshot.connection.provider
          : toolName === "cancel_provider_login"
            ? scenarioSnapshot("disconnected").connection.provider
          : toolName === "login_with_tapd_token"
          ? {
              ok: true,
              connection: {
                tapd: "connected",
                userName: connectedSnapshot.connection.provider.accountDisplayName,
                companyName: connectedSnapshot.connection.provider.tenantDisplayName,
              },
            }
          : toolName === "open_my_taskboard" || toolName === "refresh_my_work_items"
            ? scenarioSnapshot([
              "disconnected",
              "expired",
              "offline",
              "offline-detail-error",
            ].includes(scenario)
              ? "connected"
              : scenario)
            : toolName === "disconnect_provider"
              ? scenarioSnapshot("disconnected").connection.provider
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
    <>
      <output
        aria-label="刷新调用次数"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clipPath: "inset(50%)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {refreshCallCount}
      </output>
      <iframe
        ref={frameRef}
        title="FlowRivet MCP App"
        src="/dist/ui/taskboard.html"
        style={{ width: "100%", height: "100%", border: 0, display: "block" }}
      />
    </>
  );
}

const root = document.getElementById("harness-root");
if (!root) throw new Error("Harness root is missing");
createRoot(root).render(<DemoHarness />);
