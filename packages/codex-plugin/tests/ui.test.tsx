// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskboardSnapshot } from "../src/contracts/taskboard.js";
import type { WorkItemDetail } from "../src/contracts/work-item-detail.js";
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

function workItemDetail(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    key: "tapd:50396062:requirement:#10001",
    providerId: "tapd",
    projectExternalId: "50396062",
    providerItemType: "story",
    externalId: "#10001",
    projectName: "ABF 产品研发",
    kind: "requirement",
    title: "统一检索结果的排序与筛选体验",
    providerStatus: "planning",
    priority: "高",
    assignees: ["吴晨杰"],
    creator: "产品经理",
    createdAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-02T01:00:00.000Z",
    dueAt: "2026-08-09T10:00:00.000Z",
    sanitizedDescriptionHtml: "<p>支持 <strong>稳定排序</strong></p>",
    descriptionTruncated: false,
    externalUrl: "https://www.tapd.cn/50396062/prong/stories/view/10001",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    expect(document.querySelector(".app-shell")?.classList.contains("is-fullscreen")).toBe(true);
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
    expect(document.querySelector(".app-shell")?.classList.contains("is-fullscreen")).toBe(false);
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

  it("enters the board directly without project management or demo affordances", () => {
    const snapshot = {
      ...demoTaskboardSnapshot,
      projectCatalog: {
        ...demoTaskboardSnapshot.projectCatalog,
        projects: demoTaskboardSnapshot.projectCatalog.projects.map((entry) => ({
          ...entry,
          selected: false,
        })),
      },
    };
    render(<App initialSnapshot={snapshot} bridge={createBridge()} />);

    expect(screen.getByRole("region", { name: "工作项看板" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "选择项目" })).toBeNull();
    expect(screen.queryByRole("button", { name: "管理项目" })).toBeNull();
    expect(document.body.textContent).not.toContain("Demo 数据");
    expect(document.body.textContent).toContain("只读");
    for (const card of screen.getAllByRole("article")) {
      expect(card.getAttribute("aria-readonly")).toBe("true");
    }
  });

  it("refreshes real work items and replaces the board snapshot", async () => {
    const user = userEvent.setup();
    const refreshed = {
      ...demoTaskboardSnapshot,
      items: [],
      projects: demoTaskboardSnapshot.projects.map((entry) => ({ ...entry, count: 0 })),
      syncSummary: { successfulProjects: 2, failedProjects: 0, itemCount: 0 },
    };
    const callTool = vi.fn().mockResolvedValue({ content: [], structuredContent: refreshed });
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", { name: "刷新看板" }));

    expect(callTool).toHaveBeenCalledWith("refresh_my_work_items", {});
    expect(await screen.findByText("已同步 0 个工作项")).toBeTruthy();
    expect(screen.getByText("0 个工作项 · 2 个项目")).toBeTruthy();
  });

  it("keeps partial data and shows the failed project count", () => {
    render(<App initialSnapshot={{
      ...demoTaskboardSnapshot,
      syncSummary: { successfulProjects: 1, failedProjects: 1, itemCount: 7 },
    }} bridge={createBridge()} />);

    expect(screen.getByText("1 个项目同步失败，已保留其他结果")).toBeTruthy();
    expect(screen.getByRole("region", { name: "工作项看板" })).toBeTruthy();
  });

  it("shows a retryable error when refresh fails", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn().mockRejectedValue(new Error("sync failed"));
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", { name: "刷新看板" }));

    expect(await screen.findByText("看板同步失败，请重试")).toBeTruthy();
    expect(screen.getByRole("region", { name: "工作项看板" })).toBeTruthy();
  });

  it("does not present an initial synchronization failure as an empty success", () => {
    render(<App initialSnapshot={{
      ...demoTaskboardSnapshot,
      items: [],
      syncErrorCode: "work_item_sync_failed",
      syncSummary: { successfulProjects: 0, failedProjects: 2, itemCount: 0 },
    }} bridge={createBridge()} />);

    expect(screen.getByText("工作项同步失败，请重试")).toBeTruthy();
    expect(screen.queryByText("当前没有待办工作项")).toBeNull();
  });

  it("shows a login action instead of an empty board when disconnected", () => {
    render(
      <App
        initialSnapshot={snapshotWithTapdState("disconnected")}
        bridge={createBridge()}
      />,
    );

    expect(screen.getByLabelText("TAPD Token").getAttribute("type")).toBe("password");
    expect((screen.getByRole("button", { name: "连接 TAPD" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("region", { name: "工作项看板" })).toBeNull();
  });

  it("offers token replacement when the credential expired", () => {
    render(
      <App
        initialSnapshot={snapshotWithTapdState("expired")}
        bridge={createBridge()}
      />,
    );

    expect(screen.getByText(/TAPD Token 已失效/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "重新连接 TAPD" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("region", { name: "工作项看板" })).toBeNull();
  });

  it("logs in with a token, clears it, and loads the connected board", async () => {
    const user = userEvent.setup();
    const token = "personal-secret-token";
    const callTool = vi.fn(async (name: string) => {
      if (name === "login_with_tapd_token") {
        return {
          content: [],
          structuredContent: {
            ok: true,
            connection: {
              tapd: "connected",
              userName: "吴晨杰",
              companyName: "FlowRivet 测试企业",
            },
          },
        };
      }
      if (name === "open_my_taskboard") {
        return { content: [], structuredContent: demoTaskboardSnapshot };
      }
      return { content: [] };
    });
    render(
      <App
        initialSnapshot={snapshotWithTapdState("disconnected")}
        bridge={createBridge({ callTool })}
      />,
    );

    await user.type(screen.getByLabelText("TAPD Token"), token);
    await user.click(screen.getByRole("button", { name: "连接 TAPD" }));

    await vi.waitFor(() => {
      expect(callTool).toHaveBeenCalledWith("login_with_tapd_token", { token });
    });
    expect(await screen.findByRole("region", { name: "工作项看板" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(token);
  });

  it("clears a rejected token and shows a stable error", async () => {
    const user = userEvent.setup();
    const token = "invalid-secret-token";
    const callTool = vi.fn().mockResolvedValue({
      content: [],
      structuredContent: {
        ok: false,
        errorCode: "invalid_token",
        connection: { tapd: "disconnected" },
      },
    });
    render(
      <App
        initialSnapshot={snapshotWithTapdState("disconnected")}
        bridge={createBridge({ callTool })}
      />,
    );

    const input = screen.getByLabelText("TAPD Token") as HTMLInputElement;
    await user.type(input, token);
    await user.click(screen.getByRole("button", { name: "连接 TAPD" }));

    expect(await screen.findByText("Token 无效或已撤销")).toBeTruthy();
    expect(input.value).toBe("");
    expect(document.body.textContent).not.toContain(token);
  });

  it("disconnects TAPD and clears the board", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn().mockResolvedValue({
      content: [],
      structuredContent: {
        ok: true,
        connection: { tapd: "disconnected" },
      },
    });
    render(
      <App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({ callTool })} />,
    );

    await user.click(screen.getByRole("button", { name: "打开连接菜单" }));
    await user.click(screen.getByRole("button", { name: "断开 TAPD" }));

    await vi.waitFor(() => {
      expect(callTool).toHaveBeenCalledWith("disconnect_tapd", {});
    });
    expect(await screen.findByLabelText("TAPD Token")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "工作项看板" })).toBeNull();
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

  it("opens the whole card and loads provider-neutral detail", async () => {
    const user = userEvent.setup();
    const detail = workItemDetail();
    const callTool = vi.fn().mockResolvedValue({ content: [], structuredContent: detail });
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", {
      name: "打开工作项：统一检索结果的排序与筛选体验",
    }));

    const dialog = await screen.findByRole("dialog", { name: detail.title });
    expect(callTool).toHaveBeenCalledWith("get_work_item_detail", {
      providerId: "tapd",
      projectExternalId: "50396062",
      providerItemType: "story",
      externalId: "#10001",
    });
    expect(within(dialog).getByText("产品经理")).toBeTruthy();
    expect(within(dialog).getByText("吴晨杰")).toBeTruthy();
    expect(within(dialog).getByText("稳定排序")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "在 TAPD 中打开" })).toMatchObject({
      target: "_blank",
      rel: "noreferrer",
    });
  });

  it("shows loading state and a retryable provider error", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ content: []; structuredContent: WorkItemDetail }>();
    const callTool = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ content: [], structuredContent: workItemDetail() });
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", {
      name: "打开工作项：统一检索结果的排序与筛选体验",
    }));
    expect(screen.getByText("正在加载工作项详情")).toBeTruthy();
    pending.reject(new Error("provider_unavailable"));

    expect(await screen.findByText("项目管理系统暂时不可用，请稍后重试")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重试加载详情" }));
    const dialog = await screen.findByRole("dialog", { name: workItemDetail().title });
    expect(within(dialog).getByText("稳定排序")).toBeTruthy();
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("caches detail for the session and clears it after board refresh", async () => {
    const user = userEvent.setup();
    const detail = workItemDetail();
    const callTool = vi.fn(async (name: string) => ({
      content: [],
      structuredContent: name === "refresh_my_work_items"
        ? demoTaskboardSnapshot
        : detail,
    }));
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({ callTool })} />);
    const open = () => screen.getByRole("button", {
      name: "打开工作项：统一检索结果的排序与筛选体验",
    });

    await user.click(open());
    await screen.findByRole("dialog", { name: detail.title });
    await user.click(screen.getByRole("button", { name: "关闭详情" }));
    await user.click(open());
    await screen.findByRole("dialog", { name: detail.title });
    expect(callTool.mock.calls.filter(([name]) => name === "get_work_item_detail")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "关闭详情" }));
    await user.click(screen.getByRole("button", { name: "刷新看板" }));
    await user.click(open());
    await screen.findByRole("dialog", { name: detail.title });
    expect(callTool.mock.calls.filter(([name]) => name === "get_work_item_detail")).toHaveLength(2);
  });

  it("ignores a stale detail response after switching work items", async () => {
    const first = deferred<{ content: []; structuredContent: WorkItemDetail }>();
    const second = deferred<{ content: []; structuredContent: WorkItemDetail }>();
    const callTool = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({ callTool })} />);

    fireEvent.click(screen.getByRole("button", {
      name: "打开工作项：统一检索结果的排序与筛选体验",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "打开工作项：补齐搜索服务的接口契约测试",
    }));
    second.resolve({ content: [], structuredContent: workItemDetail({
      key: "tapd:50396062:task:#10002",
      providerItemType: "task",
      externalId: "#10002",
      kind: "task",
      title: "补齐搜索服务的接口契约测试",
    }) });
    expect(await screen.findByRole("dialog", {
      name: "补齐搜索服务的接口契约测试",
    })).toBeTruthy();

    first.resolve({ content: [], structuredContent: workItemDetail() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("dialog", {
      name: "补齐搜索服务的接口契约测试",
    })).toBeTruthy();
  });

  it("closes with Escape and restores focus to the originating card", async () => {
    const user = userEvent.setup();
    const detail = workItemDetail();
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({
      callTool: vi.fn().mockResolvedValue({ content: [], structuredContent: detail }),
    })} />);
    const opener = screen.getByRole("button", {
      name: "打开工作项：统一检索结果的排序与筛选体验",
    });

    await user.click(opener);
    expect(await screen.findByRole("dialog", { name: detail.title })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭详情" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
