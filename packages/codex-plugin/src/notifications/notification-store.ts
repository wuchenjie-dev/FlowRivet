import type { WorkItemNotificationList } from "../contracts/notifications.js";
import type {
  NotificationItemBaseline,
  WorkItemNotificationCandidate,
} from "./notification-diff-engine.js";

export interface NotificationAccount {
  providerId: string;
  accountKey: string;
}

export type NotificationStoreErrorCode =
  | "notification_store_read_failed"
  | "notification_store_write_failed";

export class NotificationStoreError extends Error {
  constructor(readonly code: NotificationStoreErrorCode) {
    super(code);
    this.name = "NotificationStoreError";
  }
}

export interface NotificationStore {
  loadBaseline(account: NotificationAccount): Promise<NotificationItemBaseline[] | undefined>;
  applyScan(input: {
    account: NotificationAccount;
    baseline: NotificationItemBaseline[];
    events: WorkItemNotificationCandidate[];
    now: Date;
  }): Promise<WorkItemNotificationCandidateWithId[]>;
  list(
    account: NotificationAccount,
    options: { now: Date; unreadOnly?: boolean },
  ): Promise<WorkItemNotificationList>;
  markRead(account: NotificationAccount, id: string, now: Date): Promise<void>;
  markAllRead(account: NotificationAccount, now: Date): Promise<void>;
}

export type WorkItemNotificationCandidateWithId = WorkItemNotificationCandidate & { id: string };
