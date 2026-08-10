import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Check, SlidersHorizontal, Timer, X } from "lucide-react";

const presets = [
  { value: 0, label: "不自动刷新" },
  { value: 5, label: "每 5 秒" },
  { value: 10, label: "每 10 秒" },
  { value: 30, label: "每 30 秒" },
  { value: 60, label: "每 60 秒" },
] as const;

interface AutoRefreshSettingsProps {
  value: number | undefined;
  pending: boolean;
  onSave: (value: number) => Promise<boolean>;
}

export function AutoRefreshSettings({
  value,
  pending,
  onSave,
}: AutoRefreshSettingsProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const isCustom = value !== undefined
    && value !== 0
    && !presets.some((preset) => preset.value === value);

  function closeCustom() {
    setCustomOpen(false);
    requestAnimationFrame(() => openerRef.current?.focus());
  }

  return (
    <section className="refresh-settings" aria-labelledby="refresh-settings-title">
      <div className="menu-section-heading">
        <Timer size={14} aria-hidden="true" />
        <span id="refresh-settings-title">自动刷新</span>
      </div>
      <div className="refresh-presets" aria-label="自动刷新频率">
        {presets.map((preset) => (
          <button
            key={preset.value}
            type="button"
            role="menuitemradio"
            aria-checked={value === preset.value}
            disabled={pending || value === undefined}
            onClick={() => void onSave(preset.value)}
          >
            <Check
              size={12}
              aria-hidden="true"
              className={value === preset.value ? "is-visible" : ""}
            />
            {preset.label}
          </button>
        ))}
      </div>
      <button
        ref={openerRef}
        className="menu-command refresh-custom-command"
        type="button"
        disabled={pending || value === undefined}
        aria-label="自定义刷新频率"
        onClick={() => setCustomOpen(true)}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        {isCustom ? `自定义：每 ${value} 秒` : "自定义刷新频率"}
      </button>
      {customOpen ? (
        <CustomRefreshDialog
          initialValue={value && value > 0 ? value : 60}
          pending={pending}
          onSave={onSave}
          onClose={closeCustom}
        />
      ) : null}
    </section>
  );
}

function CustomRefreshDialog({
  initialValue,
  pending,
  onSave,
  onClose,
}: {
  initialValue: number;
  pending: boolean;
  onSave: (value: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const [rawValue, setRawValue] = useState(String(initialValue));
  const dialogRef = useRef<HTMLDialogElement>(null);
  const parsedValue = Number(rawValue);
  const valid = /^\d+$/.test(rawValue)
    && Number.isInteger(parsedValue)
    && parsedValue >= 5
    && parsedValue <= 3600;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || pending) return;
    if (await onSave(parsedValue)) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="refresh-dialog"
      aria-labelledby="refresh-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onKeyDown={(event) => keepFocusInDialog(event, pending)}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section className="refresh-dialog-panel">
        <header className="reconnect-header">
          <div>
            <h2 id="refresh-dialog-title">自定义刷新频率</h2>
            <p>输入 5 至 3600 之间的整数秒数。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭自定义刷新频率"
            title="关闭自定义刷新频率"
            disabled={pending}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <form className="refresh-custom-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="refresh-interval-seconds">刷新间隔（秒）</label>
          <input
            id="refresh-interval-seconds"
            type="number"
            min="5"
            max="3600"
            step="1"
            inputMode="numeric"
            value={rawValue}
            disabled={pending}
            aria-invalid={rawValue.length > 0 && !valid}
            onChange={(event) => setRawValue(event.currentTarget.value)}
          />
          <button type="submit" disabled={pending || !valid}>
            {pending ? "正在保存..." : "保存刷新频率"}
          </button>
        </form>
      </section>
    </dialog>
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
