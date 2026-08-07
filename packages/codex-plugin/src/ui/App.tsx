import { useEffect, useState } from "react";

import { authResultSchema, type AuthErrorCode } from "../contracts/auth.js";
import { projectCatalogSchema, type ProjectCatalogResult } from "../contracts/projects.js";
import {
  taskboardSnapshotSchema,
  type CanonicalStage,
  type TaskboardSnapshot,
} from "../contracts/taskboard.js";
import type { McpAppsBridge } from "./bridge.js";
import { AppHeader } from "./components/AppHeader.js";
import { ConnectionMenu } from "./components/ConnectionMenu.js";
import { ProjectSidebar, type BoardFilter } from "./components/ProjectSidebar.js";
import { ProjectSelector } from "./components/ProjectSelector.js";
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
  const [lastSyncedAt, setLastSyncedAt] = useState(initialSnapshot.lastSyncedAt);
  const [selectedFilter, setSelectedFilter] = useState<BoardFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pingState, setPingState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [notice, setNotice] = useState<string>();
  const [authError, setAuthError] = useState<string>();
  const [authPending, setAuthPending] = useState(false);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [displayState, setDisplayState] = useState(() => bridge.getDisplayState());
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const needsProjectSelection = connection.tapd === "connected"
    && projectCatalog.projects.every((project) => !project.selected || !project.available);
  const [managingProjects, setManagingProjects] = useState(needsProjectSelection);
  const tapdState = connection.tapd;
  const canDrag = tapdState === "connected";

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

  function moveItem(key: string, stage: CanonicalStage) {
    setItems((current) => current.map((item) => item.key === key ? { ...item, stage } : item));
    setNotice("Demo：看板位置已更新，未写入 TAPD");
  }

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
    setLastSyncedAt(snapshot.lastSyncedAt);
  }

  async function callProjectTool(
    name: "discover_projects" | "add_project",
    arguments_: Record<string, unknown>,
  ): Promise<ProjectCatalogResult> {
    const result = await bridge.callTool(name, {
      providerId: projectCatalog.provider.providerId,
      ...arguments_,
    });
    const parsed = projectCatalogSchema.safeParse(result.structuredContent);
    if (!parsed.success) throw new Error("invalid project catalog");
    setProjectCatalog(parsed.data);
    return parsed.data;
  }

  async function saveProjectSelection(externalIds: string[]) {
    const result = await bridge.callTool("save_project_selection", {
      providerId: projectCatalog.provider.providerId,
      externalIds,
    });
    const parsed = projectCatalogSchema.safeParse(result.structuredContent);
    if (!parsed.success) throw new Error("invalid project catalog");
    setProjectCatalog(parsed.data);
    await loadBoard();
    setSelectedFilter("all");
    setManagingProjects(false);
    setNotice(`已启用 ${externalIds.length} 个项目`);
  }

  async function loadBoard() {
    const result = await bridge.callTool("open_my_taskboard", {});
    const parsed = taskboardSnapshotSchema.safeParse(result.structuredContent);
    if (!parsed.success) throw new Error("invalid taskboard snapshot");
    applySnapshot(parsed.data);
  }

  async function login(token: string) {
    setAuthPending(true);
    setAuthError(undefined);
    try {
      const result = await bridge.callTool("login_with_tapd_token", { token });
      const parsed = authResultSchema.safeParse(result.structuredContent);
      if (!parsed.success) throw new Error("invalid auth result");
      setConnection((current) => ({
        ...current,
        ...parsed.data.connection,
      }));
      if (!parsed.data.ok) {
        setAuthError(authErrorCopy(parsed.data.errorCode));
        return;
      }
      await loadBoard();
      setNotice("TAPD 已连接，当前工作项仍为 Demo 数据");
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
      setMenuOpen(false);
      setNotice("TAPD 已断开，本机凭据已删除");
    } catch {
      setNotice("无法断开 TAPD，请稍后重试");
    } finally {
      setDisconnectPending(false);
    }
  }

  async function refreshDemo() {
    try {
      await loadBoard();
      setNotice("Demo 数据已刷新");
    } catch {
      setNotice("看板刷新失败");
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
        onFullscreen={() => void enterFullscreen()}
        onRefresh={() => void refreshDemo()}
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
      ) : managingProjects || needsProjectSelection ? (
        <ProjectSelector
          catalog={projectCatalog}
          canCancel={!needsProjectSelection}
          onDiscover={() => callProjectTool("discover_projects", {})}
          onAdd={(input) => callProjectTool("add_project", { input })}
          onSave={saveProjectSelection}
          onCancel={() => setManagingProjects(false)}
        />
      ) : (
        <div className="workspace-layout">
          <ProjectSidebar
            projects={projects}
            selected={selectedFilter}
            onSelect={setSelectedFilter}
            onManageProjects={() => setManagingProjects(true)}
          />
          <main className="board-main">
            <div className="board-heading">
              <div><h1>我的待办</h1><p>{filteredItems.length} 个工作项 · {projects.length} 个项目</p></div>
              <span className="demo-chip">Demo 数据</span>
            </div>
            <TaskBoard stages={initialSnapshot.stages} items={filteredItems} disabled={!canDrag} onMove={moveItem} />
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
