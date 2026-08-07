import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

import { demoTaskboardSnapshot } from "../demo/fixtures.js";
import type { TaskboardSnapshot } from "../contracts/taskboard.js";
import type { ProjectCatalogResult, ProjectRef } from "../contracts/projects.js";

type Scenario =
  | "connected"
  | "disconnected"
  | "expired"
  | "projects-unselected"
  | "projects-selected"
  | "projects-stale";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function scenarioSnapshot(scenario: Scenario): TaskboardSnapshot {
  if (isProjectScenario(scenario)) {
    const catalog = scenarioCatalog(scenario);
    return projectBoardSnapshot(catalog);
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

function isProjectScenario(
  scenario: Scenario,
): scenario is Extract<Scenario, `projects-${string}`> {
  return scenario === "projects-unselected"
    || scenario === "projects-selected"
    || scenario === "projects-stale";
}

function scenarioCatalog(scenario: Extract<Scenario, `projects-${string}`>): ProjectCatalogResult {
  const selected = scenario === "projects-selected";
  return {
    provider: {
      providerId: "tapd",
      displayName: "TAPD",
      state: "connected",
      accountDisplayName: "E2E 用户",
      tenantDisplayName: "FlowRivet 测试企业",
    },
    projects: demoTaskboardSnapshot.projectCatalog.projects.map((project) => ({
      ...project,
      selected: selected && project.externalId === "50396062",
    })),
    stale: scenario === "projects-stale",
    ...(scenario === "projects-stale"
      ? { errorCode: "project_discovery_unavailable" as const }
      : {}),
  };
}

function projectBoardSnapshot(catalog: ProjectCatalogResult): TaskboardSnapshot {
  const selected = catalog.projects.filter((project) => project.selected && project.available);
  return {
    ...demoTaskboardSnapshot,
    connection: {
      ...demoTaskboardSnapshot.connection,
      tapd: "connected",
      userName: catalog.provider.accountDisplayName,
      companyName: catalog.provider.tenantDisplayName,
    },
    projectCatalog: catalog,
    projects: selected.map((project) => ({ ...project, count: 0 })),
    items: [],
  };
}

function DemoHarness() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scenario = (new URLSearchParams(location.search).get("scenario") ?? "connected") as Scenario;
  const catalogRef = useRef<ProjectCatalogResult | undefined>(
    isProjectScenario(scenario)
      ? scenarioCatalog(scenario)
      : undefined,
  );

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
        const toolName = message.params?.name;
        const connectedSnapshot = scenarioSnapshot("connected");
        let structuredContent: unknown = toolName === "login_with_tapd_token"
          ? {
              ok: true,
              connection: {
                tapd: "connected",
                userName: connectedSnapshot.connection.userName,
                companyName: connectedSnapshot.connection.companyName,
              },
            }
          : toolName === "open_my_taskboard"
            ? connectedSnapshot
            : toolName === "disconnect_tapd"
              ? { ok: true, connection: { tapd: "disconnected" } }
              : undefined;
        if (toolName === "discover_projects" && catalogRef.current) {
          structuredContent = catalogRef.current;
        }
        if (toolName === "add_project" && catalogRef.current) {
          const manual: ProjectRef = {
            providerId: "tapd",
            externalId: "9001",
            name: "手工验证项目",
            selected: false,
            available: true,
            source: "manual",
            lastVerifiedAt: "2026-08-07T00:00:00.000Z",
          };
          catalogRef.current = {
            ...catalogRef.current,
            projects: [
              ...catalogRef.current.projects.filter((project) => project.externalId !== manual.externalId),
              manual,
            ],
          };
          structuredContent = catalogRef.current;
        }
        if (toolName === "save_project_selection" && catalogRef.current) {
          const arguments_ = message.params?.arguments as { externalIds?: unknown } | undefined;
          const selectedIds = new Set(Array.isArray(arguments_?.externalIds)
            ? arguments_.externalIds.map(String)
            : []);
          catalogRef.current = {
            ...catalogRef.current,
            stale: false,
            errorCode: undefined,
            projects: catalogRef.current.projects.map((project) => ({
              ...project,
              selected: selectedIds.has(project.externalId),
            })),
          };
          structuredContent = catalogRef.current;
        }
        if (toolName === "open_my_taskboard" && catalogRef.current) {
          structuredContent = projectBoardSnapshot(catalogRef.current);
        }
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
