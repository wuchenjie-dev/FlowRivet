import { ExternalLink, RefreshCw, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { WorkItem } from "../../contracts/taskboard.js";
import type { WorkItemDetail } from "../../contracts/work-item-detail.js";

interface WorkItemDetailDrawerProps {
  item: WorkItem;
  detail?: WorkItemDetail;
  pending: boolean;
  errorCode?: string;
  onClose: () => void;
  onRetry: () => void;
}

export function WorkItemDetailDrawer({
  item,
  detail,
  pending,
  errorCode,
  onClose,
  onRetry,
}: WorkItemDetailDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

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
          {pending ? <DetailLoading /> : errorCode ? (
            <DetailError code={errorCode} onRetry={onRetry} />
          ) : detail ? <DetailContent detail={detail} /> : null}
        </div>
      </section>
    </dialog>
  );
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

function DetailError({ code, onRetry }: { code: string; onRetry: () => void }) {
  return (
    <div className="detail-error" role="alert">
      <strong>详情加载失败</strong>
      <p>{detailErrorCopy(code)}</p>
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
        在 {detail.providerId.toUpperCase()} 中打开
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
