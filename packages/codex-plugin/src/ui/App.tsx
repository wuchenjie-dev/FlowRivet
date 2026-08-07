import { useEffect, useState } from "react";

import { authResultSchema, type AuthErrorCode } from "../contracts/auth.js";
import {
  taskboardSnapshotSchema,
  type TaskboardSnapshot,
} from "../contracts/taskboard.js";
import type { McpAppsBridge } from "./bridge.js";
import { AppHeader } from "./components/AppHeader.js";
import { ConnectionMenu } from "./components/ConnectionMenu.js";
import { ProjectSidebar, type BoardFilter } from "./components/ProjectSidebar.js";
import { TaskBoard } from "./components/TaskBoard.js";
import { TapdLogin } from "./components/TapdLogin.js";

interface AppProps {
  initialSnapshot: TaskboardSnapshot;
  bridge: McpAppsBridge;
}

export function App({ initialSnapshot, bridge }: AppProps) {
  const [items, setItems] = useState(initialSnapshot.items);
  const [projects, setProjects] = useState(initialSnapshot.projects);
  const [projectCatalog, setProjectCatalog] = useState(initialSnapshot.projectCatalog);
  const [connection, setConnection] = useState(initialSnapshot.connection);
  const [syncSummary, setSyncSummary] = useState(initialSnapshot.syncSummary);
  const [syncErrorCode, setSyncErrorCode] = useState(initialSnapshot.syncErrorCode);
  const [lastSyncedAt, setLastSyncedAt] = useState(initialSnapshot.lastSyncedAt);
  const [selectedFilter, setSelectedFilter] = useState<BoardFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pingState, setPingState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [notice, setNotice] = useState<string>();
  const [authError, setAuthError] = useState<string>();
  const [authPending, setAuthPending] = useState(false);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [displayState, setDisplayState] = useState(() => bridge.getDisplayState());
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const tapdState = connection.tapd;

  async function enterFullscreen(automatic = false) {
    setFullscreenPending(true);
    try {
      setDisplayState(await bridge.requestFullscreen());
      setNotice(undefined);
    } catch {
      setNotice(automatic
        ? "无法自动进入全屏，可使用右上角按钮重试"
        : "无法进入全屏，看板仍可在当前页面使用");
    } finally {
      setFullscreenPending(false);
    }
  }

  useEffect(() => {
    if (displayState.canFullscreen && !displayState.isFullscreen) {
      void enterFullscreen(true);
    }
    // The host display capability is fixed for this mounted MCP App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  const filteredItems = items.filter((item) => {
    if (selectedFilter === "all") return true;
    if (selectedFilter === "due_soon") {
      if (!item.dueAt) return false;
      const remaining = new Date(item.dueAt).getTime() - Date.now();
      return remaining >= 0 && remaining <= 7 * 24 * 60 * 60 * 1000;
    }
    if (selectedFilter === "overdue") {
      return Boolean(item.dueAt && new Date(item.dueAt).getTime() < Date.now());
    }
    return item.projectExternalId === selectedFilter;
  });

  async function pingCompanion() {
    setPingState("pending");
    try {
      await bridge.callTool("demo_ping", { message: "taskboard-ui" });
      setPingState("success");
    } catch {
      setPingState("error");
    }
  }

  function applySnapshot(snapshot: TaskboardSnapshot) {
    setConnection(snapshot.connection);
    setProjects(snapshot.projects);
    setProjectCatalog(snapshot.projectCatalog);
    setItems(snapshot.items);
    setSyncSummary(snapshot.syncSummary);
    setSyncErrorCode(snapshot.syncErrorCode);
    setLastSyncedAt(snapshot.lastSyncedAt);
  }

  async function loadBoard(tool: "open_my_taskboard" | "refresh_my_work_items") {
    const result = await bridge.callTool(tool, {});
    const parsed = taskboardSnapshotSchema.safeParse(result.structuredContent);
    if (!parsed.success) throw new Error("invalid taskboard snapshot");
    applySnapshot(parsed.data);
    return parsed.data;
  }

  async function login(token: string) {
    setAuthPending(true);
    setAuthError(undefined);
    try {
      const result = await bridge.callTool("login_with_tapd_token", { token });
      const parsed = authResultSchema.safeParse(result.structuredContent);
      if (!parsed.success) throw new Error("invalid auth result");
      setConnection((current) => ({ ...current, ...parsed.data.connection }));
      if (!parsed.data.ok) {
        setAuthError(authErrorCopy(parsed.data.errorCode));
        return;
      }
      const snapshot = await loadBoard("open_my_taskboard");
      setNotice(`TAPD 已连接，已同步 ${snapshot.syncSummary.itemCount} 个工作项`);
    } catch {
      setAuthError("无法连接本地 Companion，请稍后重试");
    } finally {
      setAuthPending(false);
    }
  }

  async function disconnect() {
    setDisconnectPending(true);
    try {
      const result = await bridge.callTool("disconnect_tapd", {});
      const parsed = authResultSchema.safeParse(result.structuredContent);
      if (!parsed.success || !parsed.data.ok) throw new Error("disconnect failed");
      setConnection((current) => ({ ...current, ...parsed.data.connection }));
      setProjects([]);
      setProjectCatalog((current) => ({ ...current, projects: [], stale: false }));
      setItems([]);
      setSyncSummary({ successfulProjects: 0, failedProjects: 0, itemCount: 0 });
      setSyncErrorCode(undefined);
      setMenuOpen(false);
      setNotice("TAPD 已断开，本机凭据已删除");
    } catch {
      setNotice("无法断开 TAPD，请稍后重试");
    } finally {
      setDisconnectPending(false);
    }
  }

  async function refreshBoard() {
    if (refreshPending) return;
    setRefreshPending(true);
    try {
      const snapshot = await loadBoard("refresh_my_work_items");
      setNotice(`已同步 ${snapshot.syncSummary.itemCount} 个工作项`);
    } catch {
      setNotice("看板同步失败，请重试");
    } finally {
      setRefreshPending(false);
    }
  }

  const isDisconnected = tapdState !== "connected";

  return (
    <div className={`app-shell${displayState.isFullscreen ? " is-fullscreen" : ""}`}>
      <AppHeader
        connection={connection}
        lastSyncedAt={lastSyncedAt}
        menuOpen={menuOpen}
        showFullscreen={displayState.canFullscreen && !displayState.isFullscreen}
        fullscreenPending={fullscreenPending}
        refreshPending={refreshPending}
        onFullscreen={() => void enterFullscreen()}
        onRefresh={() => void refreshBoard()}
        onToggleMenu={() => setMenuOpen((open) => !open)}
      />
      {menuOpen ? (
        <ConnectionMenu
          connection={connection}
          pingState={pingState}
          onPing={pingCompanion}
          disconnectPending={disconnectPending}
          onDisconnect={() => void disconnect()}
        />
      ) : null}

      {isDisconnected ? (
        <TapdLogin
          expired={tapdState === "expired"}
          pending={authPending}
          error={authError}
          onSubmit={login}
        />
      ) : (
        <div className="workspace-layout">
          <ProjectSidebar
            projects={projects}
            selected={selectedFilter}
            onSelect={setSelectedFilter}
          />
          <main className="board-main">
            <div className="board-heading">
              <div><h1>我的待办</h1><p>{filteredItems.length} 个工作项 · {projects.length} 个项目</p></div>
              <span className="demo-chip">只读</span>
            </div>
            {syncErrorCode ? (
              <p className="sync-error" role="alert">工作项同步失败，请重试</p>
            ) : syncSummary.failedProjects > 0 ? (
              <p className="sync-warning" role="status">
                {syncSummary.failedProjects} 个项目同步失败，已保留其他结果
              </p>
            ) : null}
            <TaskBoard stages={initialSnapshot.stages} items={filteredItems} />
          </main>
        </div>
      )}
      {notice ? <div className="toast" role="status">{notice}</div> : null}
    </div>
  );
}

function authErrorCopy(code: AuthErrorCode | undefined) {
  switch (code) {
    case "invalid_token": return "Token 无效或已撤销";
    case "permission_denied": return "当前 Token 缺少所需权限";
    case "tapd_unavailable": return "TAPD 暂时不可用，请稍后重试";
    case "credential_store_failed": return "本机安全存储不可用";
    case "unsupported_platform": return "当前系统尚未支持安全存储";
    default: return "连接失败，请稍后重试";
  }
}
