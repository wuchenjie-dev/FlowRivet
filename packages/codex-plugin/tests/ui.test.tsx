// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskboardSnapshot } from "../src/contracts/taskboard.js";
import { demoTaskboardSnapshot } from "../src/demo/fixtures.js";
import { App } from "../src/ui/App.js";
import type { McpAppsBridge } from "../src/ui/bridge.js";

afterEach(cleanup);

function createBridge(overrides: Partial<McpAppsBridge> = {}): McpAppsBridge {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({
    content: [],
    structuredContent: { ok: true, repliedAt: "2026-08-06T12:00:00.000Z" },
    }),
    getDisplayState: vi.fn(() => ({ canFullscreen: true, isFullscreen: false })),
    requestFullscreen: vi.fn().mockResolvedValue({ canFullscreen: true, isFullscreen: true }),
    onToolResult: vi.fn(() => () => undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function snapshotWithTapdState(
  tapd: TaskboardSnapshot["connection"]["tapd"],
): TaskboardSnapshot {
  return {
    ...demoTaskboardSnapshot,
    connection: {
      ...demoTaskboardSnapshot.connection,
      tapd,
    },
  };
}

describe("FlowRivet taskboard", () => {
  it("renders four stages and work from every demo project", () => {
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge()} />);

    for (const heading of ["待处理", "进行中", "待验收", "已完成"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    }
    expect(screen.getAllByText("ABF 产品研发").length).toBeGreaterThan(1);
    expect(screen.getAllByText("学科工具").length).toBeGreaterThan(1);
    expect(screen.getAllByText("需求").length).toBeGreaterThan(0);
    expect(screen.getAllByText("任务").length).toBeGreaterThan(0);
    expect(screen.getAllByText("缺陷").length).toBeGreaterThan(0);
    expect(screen.getByText(/最后同步/)).toBeTruthy();
  });

  it("requests fullscreen automatically when supported", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue({
      canFullscreen: true,
      isFullscreen: true,
    });
    render(
      <App
        initialSnapshot={demoTaskboardSnapshot}
        bridge={createBridge({ requestFullscreen })}
      />,
    );

    await vi.waitFor(() => expect(requestFullscreen).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(screen.queryByRole("button", { name: "全屏打开看板" })).toBeNull();
    });
  });

  it("keeps the board usable and allows retry when fullscreen is denied", async () => {
    const user = userEvent.setup();
    const requestFullscreen = vi.fn()
      .mockRejectedValueOnce(new Error("Fullscreen denied"))
      .mockResolvedValueOnce({ canFullscreen: true, isFullscreen: true });
    render(
      <App
        initialSnapshot={demoTaskboardSnapshot}
        bridge={createBridge({ requestFullscreen })}
      />,
    );

    expect(await screen.findByText(/无法自动进入全屏/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "工作项看板" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "全屏打开看板" }));
    await vi.waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(screen.queryByRole("button", { name: "全屏打开看板" })).toBeNull();
    });
  });

  it("does not offer fullscreen when the host does not support it", async () => {
    const requestFullscreen = vi.fn();
    render(
      <App
        initialSnapshot={demoTaskboardSnapshot}
        bridge={createBridge({
          getDisplayState: vi.fn(() => ({ canFullscreen: false, isFullscreen: false })),
          requestFullscreen,
        })}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "全屏打开看板" })).toBeNull();
  });

  it("filters cards by project and restores the aggregate board", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge()} />);

    await user.click(screen.getByRole("button", { name: /筛选项目：ABF 产品研发/ }));
    const board = screen.getByRole("region", { name: "工作项看板" });
    expect(within(board).getAllByText("ABF 产品研发").length).toBeGreaterThan(0);
    expect(within(board).queryByText("学科工具")).toBeNull();

    await user.click(screen.getByRole("button", { name: /筛选项目：全部待办/ }));
    expect(within(board).getAllByText("学科工具").length).toBeGreaterThan(0);
  });

  it("shows a login action instead of an empty board when disconnected", () => {
    render(
      <App
        initialSnapshot={snapshotWithTapdState("disconnected")}
        bridge={createBridge()}
      />,
    );

    expect(screen.getByRole("button", { name: "登录 TAPD" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "工作项看板" })).toBeNull();
  });

  it("marks cached data stale and disables dragging when the token expired", () => {
    render(
      <App
        initialSnapshot={snapshotWithTapdState("expired")}
        bridge={createBridge()}
      />,
    );

    expect(screen.getByText(/数据可能已过期/)).toBeTruthy();
    for (const card of screen.getAllByRole("article")) {
      expect(card.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("shows GitLab as a non-interactive future connection", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge()} />);

    await user.click(screen.getByRole("button", { name: "打开连接菜单" }));
    expect(screen.getByText("GitLab 后续接入")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /登录 GitLab/ })).toBeNull();
  });

  it("calls demo_ping and reports the local Companion response", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn().mockResolvedValue({
      content: [],
      structuredContent: {
        ok: true,
        repliedAt: "2026-08-06T12:00:00.000Z",
      },
    });
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", { name: "打开连接菜单" }));
    await user.click(screen.getByRole("button", { name: "测试本地 Companion" }));

    expect(callTool).toHaveBeenCalledWith("demo_ping", expect.any(Object));
    expect(await screen.findByText(/本地 Companion 已响应/)).toBeTruthy();
  });
});
