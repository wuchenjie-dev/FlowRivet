import {
  Check,
  Clipboard,
  ExternalLink,
  LoaderCircle,
  LogIn,
  RefreshCw,
  RotateCcw,
  Terminal,
  X,
} from "lucide-react";
import { useState } from "react";

import type {
  ProviderConnection,
  ProviderLoginErrorCode,
  ProviderLoginSnapshot,
} from "../../contracts/providers.js";

const installCommand = "npx -y @lark-project/meegle@latest install";

interface FeishuProjectLoginProps {
  connection: ProviderConnection;
  session?: ProviderLoginSnapshot;
  action?: "starting" | "reopening" | "cancelling";
  errorCode?: ProviderLoginErrorCode;
  error?: string;
  waitingLong: boolean;
  onStart: () => void;
  onCancel: () => void;
  onReopen: () => void;
  onRecheck: () => void;
  onClose?: () => void;
  dialog?: boolean;
}

const errorCopy: Partial<Record<ProviderLoginErrorCode, string>> = {
  provider_cli_missing: "未检测到飞书项目 CLI，请先完成安装。",
  provider_cli_unsupported: "飞书项目 CLI 版本过低，请升级后重试。",
  provider_capability_unsupported: "当前飞书项目 CLI 不支持安全授权。",
  provider_login_denied: "你已拒绝本次飞书授权。",
  provider_login_failed: "飞书授权未完成，请重新授权。",
  provider_login_expired: "本次飞书授权已过期。",
  provider_login_cancelled: "本次飞书授权已取消。",
  provider_identity_validation_failed: "授权已完成，但暂时无法确认飞书账号。",
  provider_not_connected: "飞书项目尚未连接。",
  provider_unauthorized: "飞书项目登录已失效。",
  provider_unavailable: "暂时无法连接飞书项目，请稍后重试。",
  provider_timeout: "飞书项目响应超时，请稍后重试。",
  provider_output_limit_exceeded: "飞书项目 CLI 返回内容异常，请升级后重试。",
  provider_contract_invalid: "飞书项目授权响应异常，请升级 FlowRivet 或 CLI。",
};

export function FeishuProjectLogin({
  connection,
  session,
  action,
  errorCode,
  error,
  waitingLong,
  onStart,
  onCancel,
  onReopen,
  onRecheck,
  onClose,
  dialog = false,
}: FeishuProjectLoginProps) {
  const [copied, setCopied] = useState<"install" | "code">();
  const cliMissing = connection.state === "cli_missing";
  const pending = action !== undefined;
  const state = session?.state;
  const manualFallback = session?.manualFallback;
  const displayedError = error ?? (errorCode ? errorCopy[errorCode] : undefined);

  async function copy(value: string, kind: "install" | "code") {
    try {
      if (!navigator.clipboard) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setCopied(undefined);
    }
  }

  const terminal = state === "failed" || state === "expired" || state === "cancelled";
  const needsConnectionRecheck = session?.error?.recoveryAction === "recheck_connection";
  const title = cliMissing
    ? "安装飞书项目 CLI"
    : state === "starting" || action === "starting"
      ? "正在准备安全授权会话"
      : state === "waiting"
        ? waitingLong ? "仍在等待飞书确认" : "请在浏览器中完成飞书授权"
        : state === "verifying"
          ? "正在确认账号"
          : state === "succeeded"
            ? "飞书授权成功"
            : terminal
              ? "飞书授权未完成"
              : "连接飞书项目后查看我的待办";

  const content = (
    <>
      {dialog && onClose ? (
        <button
          type="button"
          className="icon-button reconnect-close"
          aria-label="关闭飞书授权"
          title="关闭"
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      ) : null}
      <span className="empty-icon">
        {cliMissing ? <Terminal size={22} aria-hidden="true" /> : <LogIn size={22} aria-hidden="true" />}
      </span>
      <h1 id={dialog ? "feishu-login-title" : undefined}>{title}</h1>
      {cliMissing ? (
        <>
          <p>FlowRivet 使用本机飞书项目 CLI 的账号，不接收或保存密码与 Token。</p>
          <div className="cli-install-command">
            <code>{installCommand}</code>
            <button type="button" onClick={() => void copy(installCommand, "install")} aria-label="复制飞书项目 CLI 安装命令" title="复制安装命令">
              {copied === "install" ? <Check size={15} aria-hidden="true" /> : <Clipboard size={15} aria-hidden="true" />}
            </button>
          </div>
          <button className="provider-login-command" type="button" onClick={onRecheck} disabled={pending}>
            <RefreshCw size={15} aria-hidden="true" />重新检查飞书项目连接
          </button>
        </>
      ) : state === "starting" || state === "verifying" || state === "succeeded" || action === "starting" ? (
        <>
          <LoaderCircle className="spin provider-login-spinner" size={18} aria-hidden="true" />
          <p>{state === "verifying" ? "正在验证本机 CLI 中的账号身份。" : state === "succeeded" ? "正在加载你的任务看板。" : "即将打开系统默认浏览器。"}</p>
        </>
      ) : state === "waiting" ? (
        <>
          <p>{waitingLong ? "授权仍然有效。请完成飞书页面中的确认，完成后将自动继续。" : "系统浏览器已打开。完成飞书页面中的确认后，FlowRivet 会自动继续。"}</p>
          {manualFallback ? (
            <div className="manual-login-fallback" role="status">
              <p>系统浏览器未能自动打开，请使用临时入口完成授权。</p>
              <a href={manualFallback.verificationUri} target="_blank" rel="noreferrer">
                <ExternalLink size={15} aria-hidden="true" />打开临时授权页
              </a>
              <div className="manual-login-code">
                <output aria-label="飞书备用授权码">{manualFallback.userCode}</output>
                <button type="button" onClick={() => void copy(manualFallback.userCode, "code")} aria-label="复制飞书备用授权码" title="复制备用授权码">
                  {copied === "code" ? <Check size={15} aria-hidden="true" /> : <Clipboard size={15} aria-hidden="true" />}
                </button>
              </div>
            </div>
          ) : null}
          <div className="provider-login-actions">
            {waitingLong || manualFallback ? (
              <button type="button" onClick={onReopen} disabled={pending}>
                <ExternalLink size={15} aria-hidden="true" />重新打开授权页
              </button>
            ) : null}
            <button type="button" onClick={onCancel} disabled={pending}>
              <X size={15} aria-hidden="true" />取消授权
            </button>
          </div>
        </>
      ) : terminal ? (
        <>
          {displayedError ? <p className="login-error" role="alert">{displayedError}</p> : null}
          <button className="provider-login-command" type="button" onClick={needsConnectionRecheck ? onRecheck : onStart} disabled={pending}>
            <RotateCcw size={15} aria-hidden="true" />{needsConnectionRecheck ? "重新检查连接" : "重新授权"}
          </button>
        </>
      ) : (
        <>
          <p>{connection.state === "expired" ? "本机飞书会话已失效，请重新授权。" : "将打开系统默认浏览器，不需要在 FlowRivet 中输入密码、Token 或验证码。"}</p>
          <button className="provider-login-command" type="button" onClick={onStart} disabled={pending}>
            {pending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />}
            {pending ? "正在启动授权..." : "连接飞书项目"}
          </button>
          {displayedError ? <p className="login-error" role="alert">{displayedError}</p> : null}
        </>
      )}
      <span className="sr-only" aria-live="polite">{title}</span>
    </>
  );

  if (dialog) {
    return (
      <dialog open className="reconnect-dialog" aria-label="重新连接飞书项目">
        <section className="reconnect-panel feishu-reconnect-panel">{content}</section>
      </dialog>
    );
  }
  return <main className="connection-empty">{content}</main>;
}
