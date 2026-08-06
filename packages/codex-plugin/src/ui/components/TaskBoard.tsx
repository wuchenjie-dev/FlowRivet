import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";

import type { CanonicalStage, WorkItem } from "../../contracts/taskboard.js";
import { TaskColumn } from "./TaskColumn.js";

interface TaskBoardProps {
  stages: readonly CanonicalStage[];
  items: WorkItem[];
  disabled: boolean;
  onMove: (key: string, stage: CanonicalStage) => void;
}

export function TaskBoard({ stages, items, disabled, onMove }: TaskBoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragEnd(event: DragEndEvent) {
    if (disabled || !event.over) return;
    const stage = event.over.id as CanonicalStage;
    if (!stages.includes(stage)) return;
    onMove(String(event.active.id), stage);
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="task-board" role="region" aria-label="工作项看板">
        {stages.map((stage) => (
          <TaskColumn
            key={stage}
            stage={stage}
            items={items.filter((item) => item.stage === stage)}
            disabled={disabled}
          />
        ))}
      </div>
    </DndContext>
  );
}
