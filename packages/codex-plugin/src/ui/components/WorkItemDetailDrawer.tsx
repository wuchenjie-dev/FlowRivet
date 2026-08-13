import { ExternalLink, Play, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { WorkItem } from "../../contracts/taskboard.js";
import type { WorkItemDetail } from "../../contracts/work-item-detail.js";
import type { WorkExecutionHandoff } from "../../contracts/executions.js";
import { ExecutionSummary } from "./ExecutionSummary.js";
import { ExecutionModeChoice } from "./ExecutionModeChoice.js";
import type { ExecutionWorkMode } from "../../contracts/executions.js";

interface WorkItemDetailDrawerProps {
  item: WorkItem;
  detail?: WorkItemDetail;
  pending: boolean;
  errorCode?: string;
  offline?: boolean;
  onClose: () => void;
  onRetry: () => void;
  execution?: WorkExecutionHandoff;
  executionPending?: boolean;
  executionError?: string;
  onStartExecution?: () => void;
  onSelectExecutionMode?: (mode: Exclude<ExecutionWorkMode, "pending">) => void;
  onChangeExecutionMode?: () => void;
  onSelectRepository?: () => void;
}

export function WorkItemDetailDrawer({
  item,
  detail,
  pending,
  errorCode,
  offline = false,
  onClose,
  onRetry,
  execution,
  executionPending = false,
  executionError,
  onStartExecution,
  onSelectExecutionMode,
  onChangeExecutionMode,
  onSelectRepository,
}: WorkItemDetailDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [changingMode, setChangingMode] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }, []);

  const title = detail?.title ?? item.title;
  const titleId = `work-item-detail-${safeId(item.key)}`;

  return (
    <dialog
      ref={dialogRef}
      className="detail-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "Tab") {
          keepFocusInDialog(event);
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="detail-panel">
        <header className="detail-header">
          <div className="detail-heading-copy">
            <span className={`kind-badge kind-badge--${item.kind}`}>{kindLabel(item.kind)}</span>
            <span className="detail-reference">{item.externalId}</span>
            <h2 id={titleId}>{title}</h2>
            <p>{item.projectName}</p>
          </div>
          <button
            type="button"
            className="icon-button detail-close"
            aria-label="关闭详情"
            title="关闭详情"
            autoFocus
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="detail-body">
          {pending ? <DetailLoading /> : errorCode ? (<>
            <DetailError code={errorCode} offline={offline} onRetry={onRetry} />
            <MinimalDetail item={item} />
          </>
          ) : detail ? <DetailContent detail={detail} /> : <MinimalDetail item={item} />}
          {onStartExecution && (!execution || executionError) ? (
            <div className="execution-actions">
              <button type="button" className="execution-primary" onClick={onStartExecution} disabled={executionPending}>
                <Play size={15} aria-hidden="true" />
                {executionPending ? "正在准备..." : execution ? "重试交给 Codex" : "交给 Codex 处理"}
              </button>
              {executionError ? <p role="alert">{executionError}</p> : null}
            </div>
          ) : null}
          {(execution?.execution.workMode === "pending" || changingMode) && onSelectExecutionMode ? (
            <ExecutionModeChoice pending={executionPending} onConfirm={(mode) => {
              onSelectExecutionMode(mode);
              setChangingMode(false);
            }} />
          ) : null}
          {execution ? <ExecutionSummary
            value={execution}
            onSelectRepository={onSelectRepository}
            onChangeMode={onChangeExecutionMode ? () => {
              onChangeExecutionMode();
              setChangingMode(true);
            } : undefined}
            allowCompatibilityCopy={Boolean(executionError)}
          /> : null}
        </div>
      </section>
    </dialog>
  );
}

function MinimalDetail({ item }: { item: WorkItem }) {
  const externalUrl = validatedHttpsUrl(item.externalUrl);
  return (
    <>
      <dl className="detail-fields">
        <DetailField label="状态" value={item.providerStatus} />
        <DetailField label="优先级" value={item.priority} />
        <DetailDate label="截止时间" value={item.dueAt} />
      </dl>
      <p className="detail-empty">详细正文请前往来源系统查看。</p>
      {externalUrl ? <a className="detail-external-link" href={externalUrl} target="_blank" rel="noreferrer">在飞书项目中打开<ExternalLink size={14} /></a> : null}
    </>
  );
}

function validatedHttpsUrl(value: string | undefined) {
  if (!value) return undefined;
  try { return new URL(value).protocol === "https:" ? value : undefined; }
  catch { return undefined; }
}

function keepFocusInDialog(event: KeyboardEvent<HTMLDialogElement>) {
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  ));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = event.currentTarget.ownerDocument.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first?.focus();
  }
}

function DetailLoading() {
  return (
    <div className="detail-loading" role="status" aria-live="polite">
      <span className="sr-only">正在加载工作项详情</span>
      <div className="detail-skeleton detail-skeleton--wide" />
      <div className="detail-skeleton" />
      <div className="detail-skeleton detail-skeleton--tall" />
    </div>
  );
}

function DetailError({
  code,
  offline,
  onRetry,
}: { code: string; offline: boolean; onRetry: () => void }) {
  return (
    <div className="detail-error" role="alert">
      <strong>详情加载失败</strong>
      <p>{offline ? "重新连接后加载详情" : detailErrorCopy(code)}</p>
      <button type="button" onClick={onRetry}>
        <RefreshCw size={14} />
        重试加载详情
      </button>
    </div>
  );
}

function DetailContent({ detail }: { detail: WorkItemDetail }) {
  return (
    <>
      <dl className="detail-fields">
        <DetailField label="状态" value={detail.providerStatus} />
        <DetailField label="优先级" value={detail.priority} />
        <DetailField label="处理人" value={detail.assignees.join("、")} />
        <DetailField label="创建人" value={detail.creator} />
        <DetailDate label="创建时间" value={detail.createdAt} />
        <DetailDate label="更新时间" value={detail.updatedAt} />
        <DetailDate label="开始时间" value={detail.startedAt} />
        <DetailDate label="截止时间" value={detail.dueAt} />
        <DetailDate label="完成时间" value={detail.completedAt} />
      </dl>

      <section className="detail-description" aria-labelledby="detail-description-heading">
        <h3 id="detail-description-heading">描述</h3>
        {detail.sanitizedDescriptionHtml ? (
          <div
            className="detail-rich-text"
            dangerouslySetInnerHTML={{ __html: detail.sanitizedDescriptionHtml }}
          />
        ) : <p className="detail-empty">暂无描述</p>}
        {detail.descriptionTruncated ? (
          <p className="detail-truncated">内容较长，已安全截断。完整内容请前往来源系统查看。</p>
        ) : null}
      </section>

      <a
        className="detail-external-link"
        href={detail.externalUrl}
        target="_blank"
        rel="noreferrer"
      >
        在 {providerLabel(detail.providerId)} 中打开
        <ExternalLink size={14} />
      </a>
    </>
  );
}

function DetailField({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function DetailDate({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd><time dateTime={value}>{formatDateTime(value)}</time></dd>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function detailErrorCopy(code: string) {
  if (code.includes("work_item_detail_forbidden")) return "该工作项未分配给当前账号，或你无权查看。";
  if (code.includes("work_item_detail_not_found")) return "工作项不存在，可能已被删除或移动。";
  if (code.includes("provider_unauthorized")) return "当前登录已失效，请重新连接项目管理系统。";
  if (code.includes("work_item_detail_unsupported")) return "暂不支持查看此类型工作项的详情。";
  if (code.includes("work_item_detail_invalid_response")) return "项目管理系统返回了无法识别的数据。";
  return "项目管理系统暂时不可用，请稍后重试";
}

function providerLabel(providerId: string) {
  return providerId === "feishu-project" ? "飞书项目"
    : providerId === "tapd" ? "TAPD"
      : providerId;
}

function kindLabel(kind: WorkItem["kind"]) {
  return {
    requirement: "需求",
    task: "任务",
    defect: "缺陷",
    other: "其他",
  }[kind];
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
