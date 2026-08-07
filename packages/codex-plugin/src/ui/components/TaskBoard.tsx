import type { CanonicalStage, WorkItem } from "../../contracts/taskboard.js";
import { TaskColumn } from "./TaskColumn.js";

interface TaskBoardProps {
  stages: readonly CanonicalStage[];
  items: WorkItem[];
}

export function TaskBoard({ stages, items }: TaskBoardProps) {
  return (
    <div className="task-board" role="region" aria-label="工作项看板">
      {stages.map((stage) => (
        <TaskColumn
          key={stage}
          stage={stage}
          items={items.filter((item) => item.stage === stage)}
        />
      ))}
    </div>
  );
}
