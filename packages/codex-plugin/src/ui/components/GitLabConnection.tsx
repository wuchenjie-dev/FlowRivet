import { Check, CircleOff, Copy, LoaderCircle, RefreshCw } from "lucide-react";

import type { GitLabConnection as GitLabConnectionState } from "../../contracts/gitlab.js";

const INSTALL_COMMAND = "winget install --id GLab.GLab --source winget";

export function GitLabConnection(props: {
  connection: GitLabConnectionState;
  pending: boolean;
  loginWaiting: boolean;
  onLogin: () => void;
  onRecheck: () => void;
}) {
  const { connection, pending, loginWaiting, onLogin, onRecheck } = props;
  const connected = connection.state === "connected";
  const secondary = connection.state === "cli_missing"
    ? "需要安装 glab CLI"
    : connection.state === "cli_unsupported"
      ? `glab ${connection.cliVersion ?? ""} 版本不兼容`
      : connected
        ? connection.accountDisplayName ?? connection.host
        : connection.state === "unavailable"
          ? "暂时无法检查连接"
          : "未连接";
  return (
    <section className="gitlab-connection" aria-label="GitLab 连接">
      <div className={`connection-row${connected ? "" : " connection-row--muted"}`}>
        <span className={`connection-icon${connected ? " connection-icon--ok" : ""}`}>
          {pending ? <LoaderCircle size={14} /> : connected ? <Check size={14} /> : <CircleOff size={14} />}
        </span>
        <div><strong>GitLab</strong><small>{secondary}</small></div>
        <span className="connection-value">{connected ? "已连接" : "需处理"}</span>
      </div>
      {connection.state === "cli_missing" ? (
        <button className="menu-command" type="button" onClick={() => void navigator.clipboard?.writeText(INSTALL_COMMAND)}>
          <Copy size={15} aria-hidden="true" />复制 glab 安装命令
        </button>
      ) : !connected && !loginWaiting ? (
        <button className="menu-command" type="button" onClick={onLogin} disabled={pending}>
          {pending ? <LoaderCircle size={15} aria-hidden="true" /> : null}连接 GitLab
        </button>
      ) : null}
      {loginWaiting ? <p className="inline-status" role="status">请在浏览器完成 GitLab 授权</p> : null}
      {!connected ? (
        <button className="menu-command" type="button" onClick={onRecheck} disabled={pending}>
          <RefreshCw size={15} aria-hidden="true" />重新检查 GitLab
        </button>
      ) : null}
    </section>
  );
}
