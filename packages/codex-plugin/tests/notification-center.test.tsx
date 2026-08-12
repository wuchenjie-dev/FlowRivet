// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { WorkItemNotificationList } from "../src/contracts/notifications.js";
import type { McpAppsBridge } from "../src/ui/bridge.js";
import { NotificationCenter } from "../src/ui/components/NotificationCenter.js";

const notification = {
  id: "notification-1",
  providerId: "feishu-project",
  workItemKey: "item-1",
  type: "assigned" as const,
  title: "实现通知中心",
  projectName: "FlowRivet",
  message: "新工作项已分配给你",
  occurredAt: "2026-08-12T00:00:00.000Z",
  externalUrl: "https://project.feishu.cn/space/story/detail/1",
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function() {
    this.removeAttribute("open");
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function bridge(callTool: McpAppsBridge["callTool"]): McpAppsBridge {
  return {
    initialize: vi.fn(),
    callTool,
    getDisplayState: vi.fn(() => ({ canFullscreen: false, isFullscreen: false })),
    requestFullscreen: vi.fn(),
    onToolResult: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  };
}

function result(value: WorkItemNotificationList) {
  return { content: [], structuredContent: value };
}

describe("notification center", () => {
  it("shows unread count and restores trigger focus after closing", async () => {
    const callTool = vi.fn(async () => result({ notifications: [notification], unreadCount: 1 }));
    render(<NotificationCenter bridge={bridge(callTool)} enabled onNotice={vi.fn()} />);

    const trigger = await screen.findByRole("button", { name: "通知，1 条未读" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("marks a notification read before opening an allowed Feishu URL", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const callTool = vi.fn(async (name: string) => result(name === "list_work_item_notifications"
      ? { notifications: [notification], unreadCount: 1 }
      : { notifications: [{ ...notification, readAt: "2026-08-12T01:00:00.000Z" }], unreadCount: 0 }));
    render(<NotificationCenter bridge={bridge(callTool)} enabled onNotice={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "通知，1 条未读" }));
    fireEvent.click(screen.getByRole("button", { name: /实现通知中心/ }));

    await waitFor(() => expect(callTool).toHaveBeenCalledWith(
      "mark_work_item_notification_read",
      { notificationId: "notification-1" },
    ));
    expect(opened).toHaveBeenCalledWith(
      notification.externalUrl,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("marks all notifications read", async () => {
    const callTool = vi.fn(async (name: string) => result(name === "list_work_item_notifications"
      ? { notifications: [notification], unreadCount: 1 }
      : { notifications: [{ ...notification, readAt: "2026-08-12T01:00:00.000Z" }], unreadCount: 0 }));
    render(<NotificationCenter bridge={bridge(callTool)} enabled onNotice={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "通知，1 条未读" }));
    fireEvent.click(screen.getByRole("button", { name: "全部标记已读" }));
    await waitFor(() => expect(callTool).toHaveBeenCalledWith(
      "mark_all_work_item_notifications_read",
      {},
    ));
    expect((await screen.findByText("0 条未读")).textContent).toBe("0 条未读");
  });

  it("offers retry after a list failure", async () => {
    const callTool = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(result({ notifications: [], unreadCount: 0 }));
    render(<NotificationCenter bridge={bridge(callTool)} enabled onNotice={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "通知，0 条未读" }));
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect((await screen.findByText("暂无工作项通知")).textContent).toBe("暂无工作项通知");
  });
});
