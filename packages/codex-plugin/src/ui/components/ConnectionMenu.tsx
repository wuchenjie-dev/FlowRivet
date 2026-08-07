import { Check, CircleOff, Server } from "lucide-react";

import type { TaskboardSnapshot } from "../../contracts/taskboard.js";

interface ConnectionMenuProps {
  connection: TaskboardSnapshot["connection"];
  pingState: "idle" | "pending" | "success" | "error";
  onPing: () => void;
  disconnectPending: boolean;
  onDisconnect: () => void;
}

export function ConnectionMenu({
  connection,
  pingState,
  onPing,
  disconnectPending,
  onDisconnect,
}: ConnectionMenuProps) {
  return (
    <div className="connection-menu" role="menu" aria-label="连接状态">
      <div className="connection-row">
        <span className="connection-icon connection-icon--ok"><Check size={14} /></span>
        <div><strong>TAPD</strong><small>{connection.companyName ?? "未连接"}</small></div>
        <span className="connection-value">{connection.tapd === "connected" ? "已连接" : "需处理"}</span>
      </div>
      <div className="connection-row connection-row--muted">
        <span className="connection-icon"><CircleOff size={14} /></span>
        <div><strong>GitLab 后续接入</strong><small>Phase 0 不读取仓库数据</small></div>
        <span className="connection-value">未配置</span>
      </div>
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
      {connection.tapd === "connected" ? (
        <button
          className="menu-command menu-command--danger"
          type="button"
          onClick={onDisconnect}
          disabled={disconnectPending}
          aria-label="断开 TAPD"
        >
          <CircleOff size={15} aria-hidden="true" />
          {disconnectPending ? "正在断开..." : "断开 TAPD"}
        </button>
      ) : null}
    </div>
  );
}
