import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { KeyRound, LogIn, X } from "lucide-react";

interface TapdLoginProps {
  expired: boolean;
  pending: boolean;
  error?: string;
  onSubmit: (token: string) => Promise<void>;
}

export function TapdLogin({
  expired,
  pending,
  error,
  onSubmit,
}: TapdLoginProps) {
  const [token, setToken] = useState("");

  return (
    <main className="connection-empty">
      <span className="empty-icon"><KeyRound size={22} aria-hidden="true" /></span>
      <h1>{expired ? "TAPD Token 已失效" : "连接 TAPD 后查看我的待办"}</h1>
      <p>Token 仅提交给本机 FlowRivet Companion，并使用 Windows DPAPI 加密保存。</p>
      <TokenForm
        idPrefix="tapd-login"
        token={token}
        pending={pending}
        error={error}
        buttonLabel={expired ? "重新连接 TAPD" : "连接 TAPD"}
        onTokenChange={setToken}
        onSubmit={onSubmit}
      />
    </main>
  );
}

interface TapdReconnectDialogProps extends Omit<TapdLoginProps, "expired"> {
  onClose: () => void;
}

export function TapdReconnectDialog({
  pending,
  error,
  onSubmit,
  onClose,
}: TapdReconnectDialogProps) {
  const [token, setToken] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="reconnect-dialog"
      aria-labelledby="reconnect-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onKeyDown={(event) => keepFocusInDialog(event, pending)}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section className="reconnect-panel">
        <header className="reconnect-header">
          <div>
            <h2 id="reconnect-title">重新连接 TAPD</h2>
            <p>验证新 Token 后立即刷新当前缓存看板。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭重新连接"
            title="关闭重新连接"
            disabled={pending}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <TokenForm
          idPrefix="tapd-reconnect"
          token={token}
          pending={pending}
          error={error}
          buttonLabel="提交并重新连接"
          autoFocus
          onTokenChange={setToken}
          onSubmit={onSubmit}
        />
      </section>
    </dialog>
  );
}

function TokenForm({
  idPrefix,
  token,
  pending,
  error,
  buttonLabel,
  autoFocus = false,
  onTokenChange,
  onSubmit,
}: {
  idPrefix: string;
  token: string;
  pending: boolean;
  error?: string;
  buttonLabel: string;
  autoFocus?: boolean;
  onTokenChange: (value: string) => void;
  onSubmit: (token: string) => Promise<void>;
}) {
  const inputId = `${idPrefix}-token`;
  const errorId = `${idPrefix}-error`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = token.trim();
    if (!submitted || pending) return;
    onTokenChange("");
    await onSubmit(submitted);
  }

  return (
    <>
      <form className="token-login" onSubmit={(event) => void submit(event)}>
        <label htmlFor={inputId}>TAPD Token</label>
        <input
          id={inputId}
          name="tapd-token"
          type="password"
          value={token}
          onChange={(event) => onTokenChange(event.currentTarget.value)}
          disabled={pending}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
        />
        <button type="submit" disabled={pending || token.trim().length === 0}>
          <LogIn size={15} aria-hidden="true" />
          {pending ? "正在验证..." : buttonLabel}
        </button>
      </form>
      {error ? <p id={errorId} className="login-error" role="alert">{error}</p> : null}
    </>
  );
}

function keepFocusInDialog(
  event: KeyboardEvent<HTMLDialogElement>,
  pending: boolean,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    if (!pending) event.currentTarget.dispatchEvent(new Event("cancel"));
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
  ));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  const active = event.currentTarget.ownerDocument.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
