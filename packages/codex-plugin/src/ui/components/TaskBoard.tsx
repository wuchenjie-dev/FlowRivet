import { AlertTriangle, Info, LogIn, WifiOff } from "lucide-react";
import type { Ref } from "react";

import type { CanonicalStage, TaskboardSnapshot, WorkItem } from "../../contracts/taskboard.js";
import { TaskColumn } from "./TaskColumn.js";

interface TaskBoardProps {
  stages: readonly CanonicalStage[];
  items: WorkItem[];
  dataFreshness: TaskboardSnapshot["dataFreshness"];
  staleScopeCount: number;
  cacheWarningCode?: TaskboardSnapshot["cacheWarningCode"];
  freshnessReasonCode?: TaskboardSnapshot["freshnessReasonCode"];
  createdSyncCoverage?: TaskboardSnapshot["createdSyncCoverage"];
  suppressMixedWarning?: boolean;
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
  cacheWarningCode,
  freshnessReasonCode,
  createdSyncCoverage,
  suppressMixedWarning = false,
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
      <CreatedSyncCoverageNotice coverage={createdSyncCoverage} />
      {cacheWarningCode ? (
        <div className="stale-banner" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span><strong>{cacheWarningCopy(cacheWarningCode)}</strong></span>
        </div>
      ) : null}
      {freshnessReasonCode === "provider_rate_limited"
        || freshnessReasonCode === "provider_unavailable" ? (
        <div className="stale-banner" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span><strong>{freshnessWarningCopy(freshnessReasonCode)}</strong></span>
        </div>
      ) : null}
      {dataFreshness === "mixed" && !suppressMixedWarning ? (
        <div className="stale-banner stale-banner--mixed" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span><strong>{staleScopeCount} 个范围使用缓存</strong>{syncTime(lastSuccessfulSyncAt)}</span>
        </div>
      ) : dataFreshness === "offline" ? (
        <div className="stale-banner stale-banner--offline" role="alert">
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

function CreatedSyncCoverageNotice({
  coverage,
}: { coverage?: TaskboardSnapshot["createdSyncCoverage"] }) {
  if (!coverage) return null;
  if (coverage.catalog === "unavailable") {
    return (
      <div className="stale-banner" role="alert">
        <AlertTriangle size={15} aria-hidden="true" />
        <span><strong>无法读取工作项类型目录，本次未同步创建任务</strong></span>
      </div>
    );
  }

  const progress = coverage.catalog === "partial"
    ? `已扫描 ${coverage.scannedTypeCount}/${coverage.knownTypeCount} 个已知类型`
    : coverage.complete
      ? `已扫描全部 ${coverage.totalTypeCount} 类`
      : `已扫描 ${coverage.scannedTypeCount}/${coverage.totalTypeCount} 类，后续自动刷新继续`;

  return (
    <>
      <div className="stale-banner stale-banner--progress" role="status" aria-live="polite">
        <Info size={15} aria-hidden="true" />
        <span><strong>{progress}</strong></span>
      </div>
      {coverage.catalog === "partial" ? (
        <div className="stale-banner" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            <strong>{coverage.failedProjectCount} 个项目的工作项类型目录读取失败</strong>
          </span>
        </div>
      ) : null}
    </>
  );
}

function cacheWarningCopy(code: NonNullable<TaskboardSnapshot["cacheWarningCode"]>) {
  switch (code) {
    case "cache_write_failed": return "本地缓存写入失败，本次结果可能无法离线保留";
    case "cache_read_failed": return "本地缓存读取失败，当前仅显示本次同步结果";
    case "cache_identity_unavailable": return "无法确认缓存身份，未加载历史缓存";
    case "cache_unavailable": return "本地缓存暂不可用";
  }
}

function freshnessWarningCopy(
  code: "provider_rate_limited" | "provider_unavailable",
) {
  return code === "provider_rate_limited"
    ? "请求频率受限，稍后会继续同步"
    : "项目管理系统暂不可用，已保留可用结果";
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
