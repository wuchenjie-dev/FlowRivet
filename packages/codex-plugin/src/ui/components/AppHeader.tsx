import { ChevronDown, Maximize2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import type { TaskboardSnapshot } from "../../contracts/taskboard.js";

interface AppHeaderProps {
  connection: TaskboardSnapshot["connection"];
  lastSyncedAt: string;
  menuOpen: boolean;
  showFullscreen: boolean;
  fullscreenPending: boolean;
  refreshPending: boolean;
  providerLoginActive?: boolean;
  onFullscreen: () => void;
  onRefresh: () => void;
  onToggleMenu: () => void;
  notificationCenter?: ReactNode;
}

const statusCopy = {
  checking: "检查中",
  cli_missing: "未安装",
  connected: "已连接",
  disconnected: "未登录",
  expired: "需重新登录",
  unavailable: "暂不可用",
} as const;

export function AppHeader({
  connection,
  lastSyncedAt,
  menuOpen,
  showFullscreen,
  fullscreenPending,
  refreshPending,
  providerLoginActive = false,
  onFullscreen,
  onRefresh,
  onToggleMenu,
  notificationCenter,
}: AppHeaderProps) {
  const syncedAt = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(lastSyncedAt));

  return (
    <header className="app-header">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">F</span>
        <div>
          <strong>FlowRivet</strong>
          <span>我的待办</span>
        </div>
      </div>
      <div className="header-actions">
        <span className={`status-dot status-dot--${providerLoginActive ? "checking" : connection.provider.state}`}>
          {connection.provider.displayName} {providerLoginActive ? "授权中" : statusCopy[connection.provider.state]}
        </span>
        <span className="sync-time">最后同步 {syncedAt}</span>
        {showFullscreen ? (
          <button
            className="icon-button"
            type="button"
            onClick={onFullscreen}
            disabled={fullscreenPending}
            aria-label="全屏打开看板"
            title="全屏打开看板"
          >
            <Maximize2 size={16} aria-hidden="true" />
          </button>
        ) : null}
        {notificationCenter}
        <button
          className="icon-button"
          type="button"
          onClick={onRefresh}
          disabled={refreshPending}
          aria-label="刷新看板"
          title="刷新看板"
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
        <button
          className="account-button"
          type="button"
          onClick={onToggleMenu}
          aria-label="打开连接菜单"
          aria-expanded={menuOpen}
        >
          <span className="avatar" aria-hidden="true">
            {connection.provider.accountDisplayName?.slice(0, 1) ?? "?"}
          </span>
          <span className="account-copy">
            <strong>{connection.provider.accountDisplayName ?? "未登录"}</strong>
            <small>{connection.provider.tenantDisplayName ?? `连接${connection.provider.displayName}`}</small>
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
