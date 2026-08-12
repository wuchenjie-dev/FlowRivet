import { useEffect, useRef, useState } from "react";

import { authResultSchema, type AuthErrorCode } from "../contracts/auth.js";
import { providerConnectionSchema } from "../contracts/providers.js";
import {
  taskboardPreferencesSchema,
  type TaskboardPreferences,
} from "../contracts/taskboard-preferences.js";
import {
  taskboardSnapshotSchema,
  type TaskboardSnapshot,
} from "../contracts/taskboard.js";
import type { McpAppsBridge } from "./bridge.js";
import { workItemDetailSchema, type WorkItemDetail } from "../contracts/work-item-detail.js";
import type { WorkItem } from "../contracts/taskboard.js";
import { AppHeader } from "./components/AppHeader.js";
import { ConnectionMenu } from "./components/ConnectionMenu.js";
import { FeishuProjectLogin } from "./components/FeishuProjectLogin.js";
import { NotificationCenter } from "./components/NotificationCenter.js";
import { ProjectSidebar, type BoardFilter } from "./components/ProjectSidebar.js";
import { TaskBoard } from "./components/TaskBoard.js";
import { TapdLogin, TapdReconnectDialog } from "./components/TapdLogin.js";
import { WorkItemDetailDrawer } from "./components/WorkItemDetailDrawer.js";
import { UpdateReadyNotice } from "./components/UpdateReadyNotice.js";
import { useAutoRefresh } from "./use-auto-refresh.js";
import { useProviderLogin } from "./use-provider-login.js";
import { useRuntimeVersion } from "./use-runtime-version.js";
import { useGitLabConnection } from "./use-gitlab-connection.js";

const EMBEDDED_UI_VERSION = import.meta.env.VITE_FLOWRIVET_UI_VERSION ?? "0.1.0";
const EMBEDDED_PROTOCOL_VERSION = 1;

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
  const [dataFreshness, setDataFreshness] = useState(initialSnapshot.dataFreshness);
  const [staleScopeCount, setStaleScopeCount] = useState(initialSnapshot.staleScopeCount);
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState(
    initialSnapshot.lastSuccessfulSyncAt,
  );
  const [selectedFilter, setSelectedFilter] = useState<BoardFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pingState, setPingState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [notice, setNotice] = useState<string>();
  const [authError, setAuthError] = useState<string>();
  const [authPending, setAuthPending] = useState(false);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [preferences, setPreferences] = useState<TaskboardPreferences>();
  const [preferencesPending, setPreferencesPending] = useState(false);
  const [displayState, setDisplayState] = useState(() => bridge.getDisplayState());
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const [selectedItem, setSelectedItem] = useState<WorkItem>();
  const [workItemDetail, setWorkItemDetail] = useState<WorkItemDetail>();
  const [detailPending, setDetailPending] = useState(false);
  const [detailErrorCode, setDetailErrorCode] = useState<string>();
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const detailCache = useRef(new Map<string, WorkItemDetail>());
  const detailRequestSequence = useRef(0);
  const detailOpener = useRef<HTMLButtonElement | undefined>(undefined);
  const reconnectOpener = useRef<HTMLButtonElement>(null);
  const providerState = connection.provider.state;
  const isFeishuProject = connection.provider.providerId === "feishu-project";
  const runtime = useRuntimeVersion({
    bridge,
    embeddedUiVersion: EMBEDDED_UI_VERSION,
    protocolVersion: EMBEDDED_PROTOCOL_VERSION,
  });
  const gitLab = useGitLabConnection({ bridge, enabled: menuOpen });

  const refreshCoordinator = useAutoRefresh({
    enabled: providerState === "connected",
    intervalSeconds: preferences?.refreshIntervalSeconds,
    performRefresh: refreshBoard,
  });
  const providerLogin = useProviderLogin({
    bridge,
    providerId: connection.provider.providerId,
    enabled: isFeishuProject && providerState !== "connected",
    onSucceeded: completeProviderLogin,
  });

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

  useEffect(() => {
    refreshCoordinator.markAttemptCompleted({
      ...(initialSnapshot.freshnessReasonCode === "provider_rate_limited"
        && initialSnapshot.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: initialSnapshot.retryAfterSeconds }
        : {}),
    });
  }, [initialSnapshot, refreshCoordinator.markAttemptCompleted]);

  useEffect(() => {
    let active = true;
    void bridge.callTool("get_taskboard_preferences", {})
      .then((result) => {
        const parsed = taskboardPreferencesSchema.safeParse(result.structuredContent);
        if (!parsed.success) throw new Error("taskboard_preferences_read_failed");
        if (active) setPreferences(parsed.data);
      })
      .catch(() => {
        if (!active) return;
        setPreferences({ refreshIntervalSeconds: 0 });
        setNotice("无法读取自动刷新设置，本次会话已关闭自动刷新");
      });
    return () => { active = false; };
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
    detailCache.current.clear();
    closeDetail(false);
    setConnection(snapshot.connection);
    setProjects(snapshot.projects);
    setProjectCatalog(snapshot.projectCatalog);
    setItems(snapshot.items);
    setSyncSummary(snapshot.syncSummary);
    setSyncErrorCode(snapshot.syncErrorCode);
    setLastSyncedAt(snapshot.lastSyncedAt);
    setDataFreshness(snapshot.dataFreshness);
    setStaleScopeCount(snapshot.staleScopeCount);
    setLastSuccessfulSyncAt(snapshot.lastSuccessfulSyncAt);
  }

  function closeDetail(restoreFocus = true) {
    detailRequestSequence.current += 1;
    setSelectedItem(undefined);
    setWorkItemDetail(undefined);
    setDetailPending(false);
    setDetailErrorCode(undefined);
    if (restoreFocus) {
      const opener = detailOpener.current;
      requestAnimationFrame(() => opener?.focus());
    }
  }

  function openDetail(item: WorkItem, opener: HTMLButtonElement) {
    if (item.providerId === "feishu-project") {
      if (!openValidatedProviderUrl(item.externalUrl)) {
        setNotice("工作项链接无效，无法打开");
      }
      return;
    }
    detailOpener.current = opener;
    setSelectedItem(item);
    const cached = detailCache.current.get(item.key);
    if (cached) {
      detailRequestSequence.current += 1;
      setWorkItemDetail(cached);
      setDetailPending(false);
      setDetailErrorCode(undefined);
      return;
    }
    void loadDetail(item);
  }

  async function loadDetail(item: WorkItem) {
    const sequence = ++detailRequestSequence.current;
    setWorkItemDetail(undefined);
    setDetailErrorCode(undefined);
    setDetailPending(true);
    try {
      const result = await bridge.callTool("get_work_item_detail", {
        providerId: item.providerId,
        projectExternalId: item.projectExternalId,
        providerItemType: item.providerItemType,
        externalId: item.externalId,
      });
      const parsed = workItemDetailSchema.safeParse(result.structuredContent);
      if (!parsed.success) throw new Error("work_item_detail_invalid_response");
      if (sequence !== detailRequestSequence.current) return;
      detailCache.current.set(item.key, parsed.data);
      setWorkItemDetail(parsed.data);
    } catch (error) {
      if (sequence !== detailRequestSequence.current) return;
      setDetailErrorCode(error instanceof Error ? error.message : "provider_unavailable");
    } finally {
      if (sequence === detailRequestSequence.current) setDetailPending(false);
    }
  }

  async function loadBoard(tool: "open_my_taskboard" | "refresh_my_work_items") {
    const result = await bridge.callTool(tool, {});
    if (result.isError) {
      const text = result.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join(" ");
      throw new Error(text.includes("provider_rate_limited")
        ? "provider_rate_limited"
        : "work_item_sync_failed");
    }
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
      setConnection((current) => ({
        ...current,
        provider: {
          ...current.provider,
          state: parsed.data.connection.tapd,
          ...(parsed.data.connection.userName
            ? { accountDisplayName: parsed.data.connection.userName }
            : {}),
          ...(parsed.data.connection.companyName
            ? { tenantDisplayName: parsed.data.connection.companyName }
            : {}),
        },
      }));
      if (!parsed.data.ok) {
        setAuthError(authErrorCopy(parsed.data.errorCode));
        return;
      }
      const snapshot = await loadBoard("open_my_taskboard");
      refreshCoordinator.markAttemptCompleted({
        ...(snapshot.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: snapshot.retryAfterSeconds }
          : {}),
      });
      setReconnectOpen(false);
      setNotice(`TAPD 已连接，已同步 ${snapshot.syncSummary.itemCount} 个工作项`);
    } catch {
      setAuthError("无法连接本地 Companion，请稍后重试");
    } finally {
      setAuthPending(false);
    }
  }

  async function startProviderLogin() {
    setAuthError(undefined);
    await providerLogin.start();
  }

  async function recheckProviderConnection() {
    setAuthError(undefined);
    try {
      const result = await bridge.callTool("get_provider_connection", {});
      const parsed = providerConnectionSchema.safeParse(result.structuredContent);
      if (!parsed.success) throw new Error("provider_connection_invalid_response");
      setConnection((current) => ({ ...current, provider: parsed.data }));
      if (parsed.data.state === "connected") {
        providerLogin.clear();
        setReconnectOpen(false);
        try {
          const snapshot = await loadBoard("open_my_taskboard");
          setNotice(`飞书项目已连接，已同步 ${snapshot.syncSummary.itemCount} 个工作项`);
        } catch {
          setNotice("飞书项目已连接，但任务同步失败，请重试");
        }
      }
    } catch {
      setAuthError("无法检查飞书项目连接，请稍后重试");
    }
  }

  async function completeProviderLogin() {
    setAuthError(undefined);
    try {
      const result = await bridge.callTool("get_provider_connection", {});
      const parsed = providerConnectionSchema.safeParse(result.structuredContent);
      if (!parsed.success || parsed.data.state !== "connected") {
        throw new Error("provider_connection_not_ready");
      }
      setConnection((current) => ({ ...current, provider: parsed.data }));
      setReconnectOpen(false);
      try {
        const snapshot = await loadBoard("open_my_taskboard");
        setNotice(`飞书项目已连接，已同步 ${snapshot.syncSummary.itemCount} 个工作项`);
      } catch {
        setNotice("飞书项目已连接，但任务同步失败，请重试");
      }
    } catch {
      setAuthError("授权已完成，但无法确认飞书账号，请重新检查连接");
    }
  }

  async function disconnect() {
    setDisconnectPending(true);
    try {
      if (isFeishuProject && providerLogin.session
        && ["starting", "waiting", "verifying"].includes(providerLogin.session.state)) {
        await providerLogin.cancel();
      }
      const result = await bridge.callTool(
        isFeishuProject ? "disconnect_provider" : "disconnect_tapd",
        {},
      );
      const nextProvider = isFeishuProject
        ? providerConnectionSchema.parse(result.structuredContent)
        : parseLegacyDisconnectedProvider(result.structuredContent, connection.provider);
      setConnection((current) => ({
        ...current,
        provider: nextProvider,
      }));
      setProjects([]);
      setProjectCatalog((current) => ({ ...current, projects: [], stale: false }));
      setItems([]);
      detailCache.current.clear();
      closeDetail(false);
      setSyncSummary({ successfulProjects: 0, failedProjects: 0, itemCount: 0 });
      setSyncErrorCode(undefined);
      setDataFreshness("live");
      setStaleScopeCount(0);
      setLastSuccessfulSyncAt(undefined);
      setMenuOpen(false);
      providerLogin.clear();
      setNotice(`${connection.provider.displayName}已断开`);
    } catch {
      setNotice(`无法断开${connection.provider.displayName}，请稍后重试`);
    } finally {
      setDisconnectPending(false);
    }
  }

  async function refreshBoard() {
    try {
      const snapshot = await loadBoard("refresh_my_work_items");
      setNotice(`已同步 ${snapshot.syncSummary.itemCount} 个工作项`);
      return {
        ...(snapshot.freshnessReasonCode === "provider_rate_limited"
          && snapshot.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: snapshot.retryAfterSeconds }
          : {}),
      };
    } catch (error) {
      setNotice("看板同步失败，请重试");
      throw error instanceof Error && error.message.includes("provider_rate_limited")
        ? error
        : new Error("work_item_sync_failed");
    }
  }

  async function saveRefreshInterval(value: number) {
    setPreferencesPending(true);
    try {
      const result = await bridge.callTool("save_taskboard_preferences", {
        refreshIntervalSeconds: value,
      });
      const parsed = taskboardPreferencesSchema.safeParse(result.structuredContent);
      if (!parsed.success) throw new Error("taskboard_preferences_invalid_response");
      setPreferences(parsed.data);
      return true;
    } catch {
      setNotice("无法保存自动刷新设置");
      return false;
    } finally {
      setPreferencesPending(false);
    }
  }

  const isDisconnected = providerState !== "connected";
  const showCachedBoard = dataFreshness === "offline"
    && (items.length > 0 || projects.length > 0);
  const showBoard = !isDisconnected || showCachedBoard;

  function closeReconnect(restoreFocus = true) {
    setReconnectOpen(false);
    if (restoreFocus) requestAnimationFrame(() => reconnectOpener.current?.focus());
  }

  return (
    <div className={`app-shell${displayState.isFullscreen ? " is-fullscreen" : ""}`}>
      {runtime.updateReady && !updateDismissed ? (
        <UpdateReadyNotice onDismiss={() => setUpdateDismissed(true)} />
      ) : null}
      <AppHeader
        connection={connection}
        lastSyncedAt={lastSyncedAt}
        menuOpen={menuOpen}
        showFullscreen={displayState.canFullscreen && !displayState.isFullscreen}
        fullscreenPending={fullscreenPending}
        refreshPending={refreshCoordinator.pending}
        providerLoginActive={Boolean(providerLogin.session
          && ["starting", "waiting", "verifying"].includes(providerLogin.session.state))}
        onFullscreen={() => void enterFullscreen()}
        onRefresh={() => void refreshCoordinator.requestRefresh().catch(() => undefined)}
        onToggleMenu={() => setMenuOpen((open) => !open)}
        notificationCenter={(
          <NotificationCenter
            bridge={bridge}
            enabled={isFeishuProject && providerState === "connected"}
            onNotice={setNotice}
          />
        )}
      />
      {menuOpen ? (
        <ConnectionMenu
          connection={connection}
          pingState={pingState}
          onPing={pingCompanion}
          disconnectPending={disconnectPending}
          onDisconnect={() => void disconnect()}
          refreshIntervalSeconds={preferences?.refreshIntervalSeconds}
          preferencesPending={preferencesPending}
          onSaveRefreshInterval={saveRefreshInterval}
          gitLab={{
            connection: gitLab.connection,
            pending: gitLab.pending,
            loginWaiting: gitLab.loginWaiting,
            onLogin: () => void gitLab.startLogin(),
            onRecheck: () => void gitLab.recheck(),
          }}
        />
      ) : null}

      {!showBoard && isFeishuProject ? (
        <FeishuProjectLogin
          connection={connection.provider}
          session={providerLogin.session}
          action={providerLogin.action}
          errorCode={providerLogin.errorCode}
          error={authError}
          waitingLong={providerLogin.waitingLong}
          onStart={() => void startProviderLogin()}
          onCancel={() => void providerLogin.cancel()}
          onReopen={() => void providerLogin.reopen()}
          onRecheck={() => void recheckProviderConnection()}
        />
      ) : !showBoard ? (
        <TapdLogin
          expired={providerState === "expired"}
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
            providerDisplayName={connection.provider.displayName}
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
            <TaskBoard
              stages={initialSnapshot.stages}
              items={filteredItems}
              dataFreshness={dataFreshness}
              staleScopeCount={staleScopeCount}
              lastSuccessfulSyncAt={lastSuccessfulSyncAt}
              reconnectButtonRef={reconnectOpener}
              onReconnect={() => {
                setAuthError(undefined);
                setReconnectOpen(true);
                if (isFeishuProject) void startProviderLogin();
              }}
              providerDisplayName={connection.provider.displayName}
              onOpenItem={openDetail}
            />
          </main>
        </div>
      )}
      {selectedItem ? (
        <WorkItemDetailDrawer
          key={selectedItem.key}
          item={selectedItem}
          detail={workItemDetail}
          pending={detailPending}
          errorCode={detailErrorCode}
          offline={dataFreshness === "offline"}
          onClose={() => closeDetail()}
          onRetry={() => void loadDetail(selectedItem)}
        />
      ) : null}
      {reconnectOpen && !isFeishuProject ? (
        <TapdReconnectDialog
          pending={authPending}
          error={authError}
          onSubmit={login}
          onClose={() => closeReconnect()}
        />
      ) : null}
      {isFeishuProject && showBoard && reconnectOpen ? (
        <FeishuProjectLogin
          connection={connection.provider}
          session={providerLogin.session}
          action={providerLogin.action}
          errorCode={providerLogin.errorCode}
          error={authError}
          waitingLong={providerLogin.waitingLong}
          onStart={() => void startProviderLogin()}
          onCancel={() => void providerLogin.cancel()}
          onReopen={() => void providerLogin.reopen()}
          onRecheck={() => void recheckProviderConnection()}
          onClose={() => closeReconnect()}
          dialog
        />
      ) : null}
      {notice ? <div className="toast" role="status">{notice}</div> : null}
    </div>
  );
}

function openValidatedProviderUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    window.open(url.toString(), "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}

function parseLegacyDisconnectedProvider(
  value: unknown,
  current: TaskboardSnapshot["connection"]["provider"],
) {
  const parsed = authResultSchema.safeParse(value);
  if (!parsed.success || !parsed.data.ok) throw new Error("disconnect failed");
  return {
    providerId: current.providerId,
    displayName: current.displayName,
    state: parsed.data.connection.tapd,
  };
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
