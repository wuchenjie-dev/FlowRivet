import { z } from "zod";

export const workItemNotificationTypes = [
  "assigned",
  "status_changed",
  "schedule_changed",
  "due_soon",
  "overdue",
] as const;

export const workItemNotificationSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  workItemKey: z.string().min(1),
  type: z.enum(workItemNotificationTypes),
  title: z.string().min(1),
  projectName: z.string().min(1),
  message: z.string().min(1),
  occurredAt: z.iso.datetime(),
  readAt: z.iso.datetime().optional(),
  externalUrl: z.url().refine((value) => new URL(value).protocol === "https:").optional(),
}).strict();

export const workItemNotificationListSchema = z.object({
  notifications: z.array(workItemNotificationSchema),
  unreadCount: z.number().int().nonnegative(),
}).strict();

export type WorkItemNotificationType = (typeof workItemNotificationTypes)[number];
export type WorkItemNotification = z.infer<typeof workItemNotificationSchema>;
export type WorkItemNotificationList = z.infer<typeof workItemNotificationListSchema>;
