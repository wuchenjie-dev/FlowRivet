import { useState, type FormEvent } from "react";
import { KeyRound, LogIn } from "lucide-react";

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = token.trim();
    if (!submitted || pending) return;
    setToken("");
    await onSubmit(submitted);
  }

  return (
    <main className="connection-empty">
      <span className="empty-icon"><KeyRound size={22} aria-hidden="true" /></span>
      <h1>{expired ? "TAPD Token 已失效" : "连接 TAPD 后查看我的待办"}</h1>
      <p>Token 仅提交给本机 FlowRivet Companion，并使用 Windows DPAPI 加密保存。</p>
      <form className="token-login" onSubmit={(event) => void submit(event)}>
        <label htmlFor="tapd-token">TAPD Token</label>
        <input
          id="tapd-token"
          name="tapd-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
          disabled={pending}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={pending || token.trim().length === 0}>
          <LogIn size={15} aria-hidden="true" />
          {pending
            ? "正在验证..."
            : expired ? "重新连接 TAPD" : "连接 TAPD"}
        </button>
      </form>
      {error ? <p className="login-error" role="alert">{error}</p> : null}
      <small>工作项仍为 Phase 1A Demo 数据</small>
    </main>
  );
}
