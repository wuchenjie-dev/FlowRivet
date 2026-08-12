import { Check, CircleOff, Server } from "lucide-react";

import type { TaskboardSnapshot } from "../../contracts/taskboard.js";
import { AutoRefreshSettings } from "./AutoRefreshSettings.js";
import { GitLabConnection } from "./GitLabConnection.js";
import type { GitLabConnection as GitLabConnectionState } from "../../contracts/gitlab.js";

interface ConnectionMenuProps {
  connection: TaskboardSnapshot["connection"];
  pingState: "idle" | "pending" | "success" | "error";
  onPing: () => void;
  disconnectPending: boolean;
  onDisconnect: () => void;
  refreshIntervalSeconds: number | undefined;
  preferencesPending: boolean;
  onSaveRefreshInterval: (value: number) => Promise<boolean>;
  gitLab: {
    connection: GitLabConnectionState;
    pending: boolean;
    loginWaiting: boolean;
    onLogin: () => void;
    onRecheck: () => void;
  };
}

export function ConnectionMenu({
  connection,
  pingState,
  onPing,
  disconnectPending,
  onDisconnect,
  refreshIntervalSeconds,
  preferencesPending,
  onSaveRefreshInterval,
  gitLab,
}: ConnectionMenuProps) {
  const disconnectLabel = connection.provider.displayName === "TAPD"
    ? "断开 TAPD"
    : `断开${connection.provider.displayName}`;
  return (
    <div className="connection-menu" role="menu" aria-label="连接状态">
      <div className="connection-row">
        <span className="connection-icon connection-icon--ok"><Check size={14} /></span>
        <div><strong>{connection.provider.displayName}</strong><small>{connection.provider.tenantDisplayName ?? "未连接"}</small></div>
        <span className="connection-value">{connection.provider.state === "connected" ? "已连接" : "需处理"}</span>
      </div>
      <GitLabConnection {...gitLab} />
      <AutoRefreshSettings
        value={refreshIntervalSeconds}
        pending={preferencesPending}
        onSave={onSaveRefreshInterval}
      />
      <button
        className="menu-command"
        type="button"
        onClick={onPing}
        disabled={pingState === "pending"}
        aria-label="测试本地 Companion"
      >
        <Server size={15} aria-hidden="true" />
        {pingState === "pending" ? "正在测试..." : "测试本地 Companion"}
      </button>
      {pingState === "success" ? <p className="inline-status inline-status--success">本地 Companion 已响应</p> : null}
      {pingState === "error" ? <p className="inline-status inline-status--error">本地 Companion 无法访问</p> : null}
      {connection.provider.state === "connected" ? (
        <button
          className="menu-command menu-command--danger"
          type="button"
          onClick={onDisconnect}
          disabled={disconnectPending}
          aria-label={disconnectLabel}
        >
          <CircleOff size={15} aria-hidden="true" />
          {disconnectPending ? "正在断开..." : disconnectLabel}
        </button>
      ) : null}
    </div>
  );
}
