export type NotificationToolName =
  | "list_work_item_notifications"
  | "mark_work_item_notification_read"
  | "mark_all_work_item_notifications_read";

export interface NotificationOperationEvent {
  requestId: string;
  tool: NotificationToolName;
  providerId: string;
  outcome: "success" | "error";
  durationMs: number;
  notificationCount?: number;
  unreadCount?: number;
  errorCode?: string;
}

export interface NotificationOperationLogger {
  completed(event: NotificationOperationEvent): void;
}

export class JsonStderrNotificationOperationLogger
implements NotificationOperationLogger {
  completed(event: NotificationOperationEvent): void {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  }
}
