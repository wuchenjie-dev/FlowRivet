import { Check, Clipboard, ExternalLink, LoaderCircle, LogIn, RefreshCw, Terminal, X } from "lucide-react";
import { useState } from "react";

import type {
  ProviderConnection,
  ProviderLoginTransaction,
} from "../../contracts/providers.js";

const installCommand = "npx -y @lark-project/meegle@latest install";

interface FeishuProjectLoginProps {
  connection: ProviderConnection;
  transaction?: ProviderLoginTransaction;
  pending: boolean;
  error?: string;
  onStart: () => void;
  onCancel: () => void;
  onRecheck: () => void;
  dialog?: boolean;
}

export function FeishuProjectLogin({
  connection,
  transaction,
  pending,
  error,
  onStart,
  onCancel,
  onRecheck,
  dialog = false,
}: FeishuProjectLoginProps) {
  const [copied, setCopied] = useState(false);
  const cliMissing = connection.state === "cli_missing";
  const authorizing = connection.state === "authorizing" || transaction !== undefined;

  async function copyInstallCommand() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const content = (
    <>
      <span className="empty-icon">
        {cliMissing ? <Terminal size={22} aria-hidden="true" /> : <LogIn size={22} aria-hidden="true" />}
      </span>
      <h1>{cliMissing ? "安装飞书项目 CLI" : authorizing ? "完成飞书授权" : "连接飞书项目后查看我的待办"}</h1>
      {cliMissing ? (
        <>
          <p>FlowRivet 使用你本机的飞书账号，不接收或保存飞书密码。</p>
          <div className="cli-install-command">
            <code>{installCommand}</code>
            <button type="button" onClick={() => void copyInstallCommand()} aria-label="复制飞书项目 CLI 安装命令" title="复制安装命令">
              {copied ? <Check size={15} aria-hidden="true" /> : <Clipboard size={15} aria-hidden="true" />}
            </button>
          </div>
          <button className="provider-login-command" type="button" onClick={onRecheck} disabled={pending}>
            <RefreshCw size={15} aria-hidden="true" />
            {pending ? "正在检查..." : "重新检查飞书项目连接"}
          </button>
        </>
      ) : transaction ? (
        <>
          <p>在飞书授权页面输入下方验证码。验证码只在本次授权期间显示。</p>
          <output className="device-code" aria-label="飞书授权验证码">{transaction.userCode}</output>
          <div className="provider-login-actions">
            <a href={transaction.verificationUri} target="_blank" rel="noreferrer">
              <ExternalLink size={15} aria-hidden="true" />打开飞书授权页面
            </a>
            <button type="button" onClick={onRecheck} disabled={pending}>
              <RefreshCw size={15} aria-hidden="true" />检查授权结果
            </button>
            <button type="button" onClick={onCancel} disabled={pending}>
              <X size={15} aria-hidden="true" />取消授权
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{connection.state === "expired" ? "本机飞书会话已失效，请重新授权。" : "将打开飞书设备授权，不需要在 FlowRivet 中输入密码或 Token。"}</p>
          <button className="provider-login-command" type="button" onClick={onStart} disabled={pending}>
            {pending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />}
            {pending ? "正在启动授权..." : "连接飞书项目"}
          </button>
        </>
      )}
      {error ? <p className="login-error" role="alert">{error}</p> : null}
      <span className="sr-only" aria-live="polite">{pending ? "飞书项目连接操作进行中" : ""}</span>
    </>
  );
  if (dialog) {
    return (
      <dialog open className="reconnect-dialog" aria-label="重新连接飞书项目">
        <section className="reconnect-panel feishu-reconnect-panel">
          {content}
        </section>
      </dialog>
    );
  }
  return <main className="connection-empty">{content}</main>;
}
