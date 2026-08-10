import { Bug, CheckSquare2, CircleDot, Lightbulb } from "lucide-react";

import type { WorkItem } from "../../contracts/taskboard.js";

const kindPresentation = {
  requirement: { label: "需求", Icon: Lightbulb },
  task: { label: "任务", Icon: CheckSquare2 },
  defect: { label: "缺陷", Icon: Bug },
  other: { label: "其他", Icon: CircleDot },
} as const;

interface WorkItemCardProps {
  item: WorkItem;
  onOpen: (item: WorkItem, opener: HTMLButtonElement) => void;
}

export function WorkItemCard({ item, onOpen }: WorkItemCardProps) {
  const { label, Icon } = kindPresentation[item.kind];
  const dueAt = item.dueAt
    ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(item.dueAt))
    : undefined;

  return (
    <article
      className="work-card"
      role="article"
      aria-readonly="true"
    >
      <button
        type="button"
        className="work-card-button"
        aria-label={`打开工作项：${item.title}`}
        onClick={(event) => onOpen(item, event.currentTarget)}
      >
        <div className="card-topline">
          <span className={`kind-badge kind-badge--${item.kind}`}><Icon size={13} />{label}</span>
          <span className="tapd-id">{item.externalId}</span>
          <span className="provider-status">{item.providerStatus}</span>
        </div>
        <h3>{item.title}</h3>
        <div className="card-meta">
          <span className="project-name">{item.projectName}</span>
          {item.priority ? <span className={`priority priority--${item.priority}`}>{item.priority}</span> : null}
          {dueAt ? <time dateTime={item.dueAt}>截止 {dueAt}</time> : null}
        </div>
      </button>
    </article>
  );
}
