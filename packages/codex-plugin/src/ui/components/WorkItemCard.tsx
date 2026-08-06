import { useDraggable } from "@dnd-kit/core";
import { Bug, CheckSquare2, GripVertical, Lightbulb } from "lucide-react";

import type { WorkItem } from "../../contracts/taskboard.js";

const kindPresentation = {
  story: { label: "需求", Icon: Lightbulb },
  task: { label: "任务", Icon: CheckSquare2 },
  bug: { label: "缺陷", Icon: Bug },
} as const;

interface WorkItemCardProps {
  item: WorkItem;
  disabled: boolean;
}

export function WorkItemCard({ item, disabled }: WorkItemCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.key,
    data: { item },
    disabled,
  });
  const { label, Icon } = kindPresentation[item.kind];
  const dueAt = item.dueAt
    ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(item.dueAt))
    : undefined;

  return (
    <article
      ref={setNodeRef}
      className={isDragging ? "work-card is-dragging" : "work-card"}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      {...attributes}
      {...listeners}
      role="article"
      aria-disabled={disabled}
    >
      <div className="card-topline">
        <span className={`kind-badge kind-badge--${item.kind}`}><Icon size={13} />{label}</span>
        <span className="tapd-id">{item.tapdId}</span>
        <GripVertical className="drag-handle" size={15} aria-hidden="true" />
      </div>
      <h3>{item.title}</h3>
      <div className="card-meta">
        <span className="project-name">{item.workspaceName}</span>
        {item.priority ? <span className={`priority priority--${item.priority}`}>{item.priority}</span> : null}
        {dueAt ? <time dateTime={item.dueAt}>截止 {dueAt}</time> : null}
      </div>
    </article>
  );
}
