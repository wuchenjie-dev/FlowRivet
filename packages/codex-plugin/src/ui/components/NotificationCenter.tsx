import { Bell, CheckCheck, ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  workItemNotificationListSchema,
  type WorkItemNotificationList,
} from "../../contracts/notifications.js";
import type { McpAppsBridge } from "../bridge.js";

interface NotificationCenterProps {
  bridge: McpAppsBridge;
  enabled: boolean;
  onNotice: (message: string) => void;
}

const EMPTY: WorkItemNotificationList = { notifications: [], unreadCount: 0 };

export function NotificationCenter({ bridge, enabled, onNotice }: NotificationCenterProps) {
  const [inbox, setInbox] = useState(EMPTY);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    setPending(true);
    try {
      const result = await bridge.callTool("list_work_item_notifications", {});
      const parsed = workItemNotificationListSchema.safeParse(result.structuredContent);
      if (!parsed.success) throw new Error("notification_list_invalid");
      setInbox(parsed.data);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }, [bridge, enabled]);

  useEffect(() => {
    if (enabled) void load();
    else setInbox(EMPTY);
  }, [enabled, load]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load, open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function close() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function markAllRead() {
    try {
      const result = await bridge.callTool("mark_all_work_item_notifications_read", {});
      setInbox(workItemNotificationListSchema.parse(result.structuredContent));
    } catch {
      onNotice("通知状态更新失败，请重试");
    }
  }

  async function openNotification(id: string, externalUrl?: string) {
    try {
      const result = await bridge.callTool("mark_work_item_notification_read", {
        notificationId: id,
      });
      setInbox(workItemNotificationListSchema.parse(result.structuredContent));
    } catch {
      onNotice("通知状态更新失败，请重试");
      return;
    }
    if (!externalUrl || !openFeishuProjectUrl(externalUrl)) {
      onNotice("工作项链接无效，无法打开");
    }
  }

  if (!enabled) return null;
  return (
    <>
      <button
        ref={triggerRef}
        className="icon-button notification-trigger"
        type="button"
        aria-label={`通知，${inbox.unreadCount} 条未读`}
        aria-expanded={open}
        title="工作项通知"
        onClick={() => setOpen(true)}
      >
        <Bell size={16} aria-hidden="true" />
        {inbox.unreadCount > 0 ? (
          <span className="notification-badge" aria-hidden="true">
            {inbox.unreadCount > 99 ? "99+" : inbox.unreadCount}
          </span>
        ) : null}
      </button>
      <dialog
        ref={dialogRef}
        className="notification-dialog"
        aria-labelledby="notification-title"
        onCancel={(event) => { event.preventDefault(); close(); }}
        onClose={() => { if (open) setOpen(false); }}
        onClick={(event) => { if (event.target === dialogRef.current) close(); }}
      >
        <section className="notification-panel">
          <header className="notification-header">
            <div>
              <h2 id="notification-title">工作项通知</h2>
              <p>{inbox.unreadCount} 条未读</p>
            </div>
            <div className="notification-header-actions">
              <button
                className="icon-button"
                type="button"
                disabled={inbox.unreadCount === 0}
                onClick={() => void markAllRead()}
                aria-label="全部标记已读"
                title="全部标记已读"
              ><CheckCheck size={16} aria-hidden="true" /></button>
              <button className="icon-button" type="button" onClick={close} aria-label="关闭通知">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className="notification-body">
            {failed ? (
              <div className="notification-state" role="alert">
                <p>通知加载失败</p>
                <button type="button" onClick={() => void load()}>重试</button>
              </div>
            ) : pending && inbox.notifications.length === 0 ? (
              <p className="notification-state">正在加载...</p>
            ) : inbox.notifications.length === 0 ? (
              <p className="notification-state">暂无工作项通知</p>
            ) : (
              <ol className="notification-list">
                {inbox.notifications.map((notification) => (
                  <li key={notification.id} className={notification.readAt ? "is-read" : "is-unread"}>
                    <button
                      type="button"
                      onClick={() => void openNotification(notification.id, notification.externalUrl)}
                    >
                      <span className="notification-copy">
                        <strong>{notification.title}</strong>
                        <span>{notification.message}</span>
                        <small>{notification.projectName} · {relativeTime(notification.occurredAt)}</small>
                      </span>
                      <ExternalLink size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </dialog>
    </>
  );
}

function openFeishuProjectUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "project.feishu.cn") return false;
    window.open(url.toString(), "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}

function relativeTime(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
