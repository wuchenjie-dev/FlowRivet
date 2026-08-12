import { Copy, X } from "lucide-react";

const REOPEN_COMMAND = "重新打开 FlowRivet 看板";

export function UpdateReadyNotice(props: {
  onCopy?: (value: string) => Promise<void> | void;
  onDismiss: () => void;
}) {
  const copy = props.onCopy ?? ((value: string) => navigator.clipboard.writeText(value));
  return (
    <section className="update-ready-notice" role="status" aria-label="FlowRivet 更新">
      <div>
        <strong>新版已就绪</strong>
        <span>重新打开看板即可使用，无需退出 Codex。</span>
      </div>
      <button type="button" onClick={() => void copy(REOPEN_COMMAND)}>
        <Copy size={14} aria-hidden="true" />复制重新打开指令
      </button>
      <button type="button" className="update-ready-dismiss" onClick={props.onDismiss}>
        <X size={14} aria-hidden="true" />稍后
      </button>
    </section>
  );
}
