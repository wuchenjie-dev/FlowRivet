import type {
  CanonicalStage,
  WorkItem,
} from "../contracts/taskboard.js";
import type { WorkItemNotificationType } from "../contracts/notifications.js";

const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface NotificationItemBaseline {
  workItemKey: string;
  title: string;
  projectName: string;
  stage: CanonicalStage;
  providerStatus: string;
  dueAt?: string;
  externalUrl?: string;
  observedAt: string;
}

export interface WorkItemNotificationCandidate {
  providerId: string;
  workItemKey: string;
  type: WorkItemNotificationType;
  title: string;
  projectName: string;
  message: string;
  occurredAt: string;
  externalUrl?: string;
  dedupeMaterial: string;
}

export interface WorkItemNotificationDiffInput {
  previous?: readonly NotificationItemBaseline[];
  items: readonly WorkItem[];
  now: Date;
  previousEventKeys?: ReadonlySet<string>;
}

export interface WorkItemNotificationDiffResult {
  events: WorkItemNotificationCandidate[];
  next: NotificationItemBaseline[];
}

export function detectWorkItemNotificationChanges(
  input: WorkItemNotificationDiffInput,
): WorkItemNotificationDiffResult {
  const previousByKey = new Map(
    input.previous?.map((entry) => [entry.workItemKey, entry]),
  );
  const events: WorkItemNotificationCandidate[] = [];
  const next: NotificationItemBaseline[] = [];
  const isFirstBaseline = input.previous === undefined;

  for (const item of input.items) {
    const previous = previousByKey.get(item.key);
    if (item.freshness === "cached") {
      if (previous) next.push(previous);
      continue;
    }

    next.push(toBaseline(item, input.now));
    if (isFirstBaseline) continue;

    if (!previous) {
      if (item.stage !== "done") {
        addEvent(events, input, item, "assigned", "新任务已分配给你", "new");
      }
      continue;
    }

    if (previous.stage !== item.stage || previous.providerStatus !== item.providerStatus) {
      addEvent(
        events,
        input,
        item,
        "status_changed",
        `任务状态已更新为${stageLabel(item.stage)}`,
        `${previous.stage}:${previous.providerStatus}->${item.stage}:${item.providerStatus}`,
      );
    }
    if (previous.dueAt !== item.dueAt) {
      addEvent(
        events,
        input,
        item,
        "schedule_changed",
        item.dueAt ? `截止时间已调整为${dateLabel(item.dueAt)}` : "截止时间已移除",
        `${previous.dueAt ?? "none"}->${item.dueAt ?? "none"}`,
      );
    }

    if (item.stage === "done") continue;
    const dueAt = timestamp(item.dueAt);
    if (dueAt === undefined) continue;
    const remaining = dueAt - input.now.getTime();
    if (remaining < 0) {
      addEvent(events, input, item, "overdue", "任务已逾期", item.dueAt as string);
    } else if (remaining <= DUE_SOON_WINDOW_MS) {
      addEvent(events, input, item, "due_soon", "任务将在24小时内到期", item.dueAt as string);
    }
  }

  return { events, next };
}

function addEvent(
  events: WorkItemNotificationCandidate[],
  input: WorkItemNotificationDiffInput,
  item: WorkItem,
  type: WorkItemNotificationType,
  message: string,
  change: string,
) {
  const dedupeMaterial = `${item.key}\u0000${type}\u0000${change}`;
  if (input.previousEventKeys?.has(dedupeMaterial)) return;
  events.push({
    providerId: item.providerId,
    workItemKey: item.key,
    type,
    title: item.title,
    projectName: item.projectName,
    message,
    occurredAt: input.now.toISOString(),
    ...(item.externalUrl ? { externalUrl: item.externalUrl } : {}),
    dedupeMaterial,
  });
}

function toBaseline(item: WorkItem, now: Date): NotificationItemBaseline {
  return {
    workItemKey: item.key,
    title: item.title,
    projectName: item.projectName,
    stage: item.stage,
    providerStatus: item.providerStatus,
    ...(item.dueAt ? { dueAt: item.dueAt } : {}),
    ...(item.externalUrl ? { externalUrl: item.externalUrl } : {}),
    observedAt: now.toISOString(),
  };
}

function timestamp(value: string | undefined) {
  if (!value) return undefined;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : undefined;
}

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

function stageLabel(stage: CanonicalStage) {
  switch (stage) {
    case "todo": return "待处理";
    case "in_progress": return "进行中";
    case "in_review": return "待验收";
    case "done": return "已完成";
  }
}
