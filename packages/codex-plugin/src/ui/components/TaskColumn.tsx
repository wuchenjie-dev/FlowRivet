import { useDroppable } from "@dnd-kit/core";

import type { CanonicalStage, WorkItem } from "../../contracts/taskboard.js";
import { WorkItemCard } from "./WorkItemCard.js";

const stageLabels: Record<CanonicalStage, string> = {
  todo: "待处理",
  in_progress: "进行中",
  in_review: "待验收",
  done: "已完成",
};

interface TaskColumnProps {
  stage: CanonicalStage;
  items: WorkItem[];
  disabled: boolean;
}

export function TaskColumn({ stage, items, disabled }: TaskColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage, disabled });
  return (
    <section ref={setNodeRef} className={isOver ? "task-column is-over" : "task-column"} aria-label={`${stageLabels[stage]}列`}>
      <header className="column-header">
        <h2>{stageLabels[stage]}</h2>
        <span>{items.length}</span>
      </header>
      <div className="column-body">
        {items.map((item) => <WorkItemCard key={item.key} item={item} disabled={disabled} />)}
        {items.length === 0 ? <p className="column-empty">暂无工作项</p> : null}
      </div>
    </section>
  );
}
