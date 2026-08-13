import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  defaultTaskboardPreferences,
  taskboardPreferencesSchema,
} from "../contracts/taskboard-preferences.js";
import type { ProviderLoginSnapshot } from "../contracts/providers.js";
import type { WorkItemNotificationList } from "../contracts/notifications.js";
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
  | "offline-detail-error"
  | "manual-browser"
  | "expired-login"
  | "repository";

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
        state: scenario === "manual-browser" || scenario === "expired-login"
          ? "disconnected"
          : scenario === "repository" ? "connected" : scenario,
        ...(scenario !== "connected" && scenario !== "repository"
          ? { accountDisplayName: undefined, tenantDisplayName: undefined }
          : {}),
      },
    },
  };
}

function DemoHarness() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const preferencesRef = useRef({ ...defaultTaskboardPreferences });
  const loginSessionRef = useRef<ProviderLoginSnapshot | undefined>(undefined);
  const loginReadCountRef = useRef(0);
  const notificationsRef = useRef<WorkItemNotificationList>({
    unreadCount: 1,
    notifications: [{
      id: "demo-notification-1",
      providerId: "feishu-project",
      workItemKey: "feishu-project:PROJ-1:work_item:1",
      type: "assigned",
      title: "统一检索结果的排序与筛选体验",
      projectName: "FlowRivet Sandbox",
      message: "新工作项已分配给你",
      occurredAt: new Date().toISOString(),
      externalUrl: "https://project.feishu.cn/demo/work_item/1",
    }],
  });
  const [refreshCallCount, setRefreshCallCount] = useState(0);
  const scenario = (new URLSearchParams(location.search).get("scenario") ?? "connected") as Scenario;
  const directoryOutcome = new URLSearchParams(location.search).get("directory") ?? "selected";

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
        if (toolName === "list_work_item_notifications") {
          send({ jsonrpc: "2.0", id: message.id, result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent: notificationsRef.current,
          } });
          return;
        }
        if (toolName === "mark_work_item_notification_read"
          || toolName === "mark_all_work_item_notifications_read") {
          const readAt = new Date().toISOString();
          notificationsRef.current = {
            unreadCount: 0,
            notifications: notificationsRef.current.notifications.map((entry) => ({
              ...entry,
              readAt,
            })),
          };
          send({ jsonrpc: "2.0", id: message.id, result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent: notificationsRef.current,
          } });
          return;
        }
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
        if (toolName === "start_provider_login") {
          loginReadCountRef.current = 0;
          loginSessionRef.current = createLoginSession(
            scenario === "manual-browser" ? "waiting" : "starting",
            scenario === "manual-browser",
          );
        }
        if (toolName === "get_provider_login" && loginSessionRef.current) {
          loginReadCountRef.current += 1;
          loginSessionRef.current = advanceLoginSession(
            loginSessionRef.current,
            scenario,
            loginReadCountRef.current,
          );
        }
        if (toolName === "reopen_provider_login" && loginSessionRef.current) {
          loginSessionRef.current = {
            ...loginSessionRef.current,
            browserLaunch: "opened",
            manualFallback: undefined,
            error: undefined,
            updatedAt: new Date().toISOString(),
          };
        }
        if (toolName === "cancel_provider_login" && loginSessionRef.current) {
          loginSessionRef.current = {
            ...loginSessionRef.current,
            state: "cancelled",
            manualFallback: undefined,
            error: {
              code: "provider_login_cancelled",
              retryable: true,
              recoveryAction: "retry_login",
              requestId: "demo-cancel",
            },
            updatedAt: new Date().toISOString(),
          };
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
        const structuredContent = toolName === "get_runtime_version"
          ? { version: "0.1.0", protocolVersion: 1, uiVersion: "0.1.0" }
          : toolName === "start_provider_login"
          ? { requestId: "demo-start", session: loginSessionRef.current }
          : toolName === "get_provider_login"
            ? { requestId: "demo-get", ...(loginSessionRef.current ? { session: loginSessionRef.current } : {}) }
          : toolName === "reopen_provider_login"
            ? { requestId: "demo-reopen", session: loginSessionRef.current }
          : toolName === "get_provider_connection"
            ? connectedSnapshot.connection.provider
          : toolName === "cancel_provider_login"
            ? { requestId: "demo-cancel", session: loginSessionRef.current }
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
              "manual-browser",
              "expired-login",
            ].includes(scenario)
              ? "connected"
              : scenario)
            : toolName === "disconnect_provider"
              ? scenarioSnapshot("disconnected").connection.provider
            : toolName === "disconnect_tapd"
              ? { ok: true, connection: { tapd: "disconnected" } }
              : toolName === "get_work_item_detail" && detailReference.success
                ? demoWorkItemDetail(detailReference.data)
              : toolName === "prepare_work_item_execution"
                ? demoExecution(message.params?.arguments, scenario === "repository")
              : toolName === "list_gitlab_projects"
                ? {
                    page: 1, hasMore: false, projects: [{
                      host: "gitlab-aiabu.ruijie.com.cn", projectId: "1",
                      pathWithNamespace: "team/flowrivet", displayName: "FlowRivet",
                      defaultBranch: "main", httpUrl: "https://gitlab-aiabu.ruijie.com.cn/team/flowrivet.git",
                    }],
                  }
              : toolName === "get_gitlab_project"
                ? {
                    host: "gitlab-aiabu.ruijie.com.cn", projectId: "1",
                    pathWithNamespace: "team/flowrivet", displayName: "FlowRivet",
                    defaultBranch: "main", httpUrl: "https://gitlab-aiabu.ruijie.com.cn/team/flowrivet.git",
                  }
              : toolName === "select_local_directory" && directoryOutcome === "selected"
                ? { outcome: "selected", absolutePath: "C:\\workspace\\example" }
              : toolName === "select_local_directory" && directoryOutcome === "cancelled"
                ? { outcome: "cancelled" }
              : undefined;
        if (toolName === "select_local_directory" && directoryOutcome === "unavailable") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "directory_picker_unavailable" },
          });
          return;
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
  }, [directoryOutcome, scenario]);

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

function demoExecution(argumentsValue: unknown, awaitRepository = false) {
  const item = argumentsValue && typeof argumentsValue === "object" && "item" in argumentsValue
    ? (argumentsValue as { item?: { key?: string } }).item
    : undefined;
  return {
    execution: {
      schemaVersion: 1, executionId: "demo-execution-1", providerId: "feishu-project",
      accountKey: "demo-user", workItemKey: item?.key ?? "demo-item", taskLaunchMode: "handoff",
      codexHandoffId: "flowrivet-demo-execution-1", executionKind: "development",
      state: awaitRepository ? "awaiting_repository" : "writeback_pending", artifacts: [], createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      ...(awaitRepository ? {} : { gitlab: {
        host: "gitlab-aiabu.ruijie.com.cn", projectId: "1", projectPath: "cc/flowrivet",
        localPath: "C:\\workspace\\a-very-long-directory-name\\flowrivet",
        branch: "codex/feishu-work-item-123", mergeRequestIid: 9,
        mergeRequestUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet/-/merge_requests/9",
        pipelineId: "42",
      } }),
    },
    handoff: { handoffId: "flowrivet-demo-execution-1", prompt: "Continue FlowRivet demo execution" },
  };
}

function createLoginSession(
  state: ProviderLoginSnapshot["state"],
  manualBrowser: boolean,
): ProviderLoginSnapshot {
  const now = Date.now();
  return {
    sessionId: "demo-login-session",
    providerId: "feishu-project",
    state,
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    browserLaunch: manualBrowser ? "manual_required" : "opened",
    ...(manualBrowser ? {
      error: {
        code: "provider_browser_launch_failed" as const,
        retryable: true,
        recoveryAction: "open_manually" as const,
        requestId: "demo-start",
      },
      manualFallback: {
        verificationUri: "https://open.feishu.cn/device?code=demo",
        userCode: "DEMO-CODE",
      },
    } : {}),
  };
}

function advanceLoginSession(
  current: ProviderLoginSnapshot,
  scenario: Scenario,
  readCount: number,
): ProviderLoginSnapshot {
  if (!["starting", "waiting", "verifying"].includes(current.state)) return current;
  if (scenario === "manual-browser") return current;
  const state = scenario === "expired-login" && readCount >= 2
    ? "expired"
    : readCount === 1
      ? "waiting"
      : readCount === 2
        ? "verifying"
        : "succeeded";
  return {
    ...current,
    state,
    updatedAt: new Date().toISOString(),
    ...(state === "expired" ? {
      error: {
        code: "provider_login_expired" as const,
        retryable: true,
        recoveryAction: "retry_login" as const,
        requestId: "demo-get",
      },
    } : {}),
  };
}

const root = document.getElementById("harness-root");
if (!root) throw new Error("Harness root is missing");
createRoot(root).render(<DemoHarness />);
