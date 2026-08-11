import { AlertTriangle, LogIn, WifiOff } from "lucide-react";
import type { Ref } from "react";

import type { CanonicalStage, TaskboardSnapshot, WorkItem } from "../../contracts/taskboard.js";
import { TaskColumn } from "./TaskColumn.js";

interface TaskBoardProps {
  stages: readonly CanonicalStage[];
  items: WorkItem[];
  dataFreshness: TaskboardSnapshot["dataFreshness"];
  staleScopeCount: number;
  lastSuccessfulSyncAt?: string;
  reconnectButtonRef?: Ref<HTMLButtonElement>;
  onReconnect: () => void;
  providerDisplayName: string;
  onOpenItem: (item: WorkItem, opener: HTMLButtonElement) => void;
}

export function TaskBoard({
  stages,
  items,
  dataFreshness,
  staleScopeCount,
  lastSuccessfulSyncAt,
  reconnectButtonRef,
  onReconnect,
  providerDisplayName,
  onOpenItem,
}: TaskBoardProps) {
  const reconnectLabel = providerDisplayName === "TAPD"
    ? "重新连接 TAPD"
    : `重新连接${providerDisplayName}`;
  return (
    <>
      {dataFreshness === "mixed" ? (
        <div className="stale-banner stale-banner--mixed" role="status" aria-live="polite">
          <AlertTriangle size={15} aria-hidden="true" />
          <span><strong>{staleScopeCount} 个范围使用缓存</strong>{syncTime(lastSuccessfulSyncAt)}</span>
        </div>
      ) : dataFreshness === "offline" ? (
        <div className="stale-banner stale-banner--offline" role="status" aria-live="polite">
          <WifiOff size={15} aria-hidden="true" />
          <span><strong>正在显示离线缓存</strong>{syncTime(lastSuccessfulSyncAt)}</span>
          <button ref={reconnectButtonRef} type="button" onClick={onReconnect}>
            <LogIn size={14} aria-hidden="true" />
            {reconnectLabel}
          </button>
        </div>
      ) : null}
      <div className="task-board" role="region" aria-label="工作项看板">
        {stages.map((stage) => (
          <TaskColumn
            key={stage}
            stage={stage}
            items={items.filter((item) => item.stage === stage)}
            onOpenItem={onOpenItem}
          />
        ))}
      </div>
    </>
  );
}

function syncTime(value?: string) {
  if (!value) return null;
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
  return <small>最后成功同步 {formatted}</small>;
}
