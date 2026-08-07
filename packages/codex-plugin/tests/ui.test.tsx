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

function projectSelectionSnapshot(): TaskboardSnapshot {
  return {
    ...demoTaskboardSnapshot,
    projectCatalog: {
      ...demoTaskboardSnapshot.projectCatalog,
      projects: [
        { ...demoTaskboardSnapshot.projectCatalog.projects[0], selected: false },
        { ...demoTaskboardSnapshot.projectCatalog.projects[1], selected: false },
        {
          providerId: "tapd",
          externalId: "missing",
          name: "历史项目",
          selected: true,
          available: false,
          source: "manual",
          lastVerifiedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      stale: false,
    },
    projects: [],
    items: [],
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

  it("searches, selects and saves a discovered project", async () => {
    const user = userEvent.setup();
    const selectedCatalog = {
      ...projectSelectionSnapshot().projectCatalog,
      projects: projectSelectionSnapshot().projectCatalog.projects.map((project) => ({
        ...project,
        selected: project.externalId === "50396062",
      })),
    };
    const board = {
      ...demoTaskboardSnapshot,
      projectCatalog: selectedCatalog,
      projects: [{ ...selectedCatalog.projects[0], count: 0 }],
      items: [],
    };
    const callTool = vi.fn(async (name: string) => ({
      content: [],
      structuredContent: name === "save_project_selection" ? selectedCatalog : board,
    }));
    render(<App initialSnapshot={projectSelectionSnapshot()} bridge={createBridge({ callTool })} />);

    expect(screen.getByRole("heading", { name: "选择项目" })).toBeTruthy();
    await user.type(screen.getByRole("searchbox", { name: "搜索项目" }), "ABF");
    await user.click(screen.getByRole("checkbox", { name: "选择项目：ABF 产品研发" }));
    await user.click(screen.getByRole("button", { name: "使用 1 个项目" }));

    expect(callTool).toHaveBeenCalledWith("save_project_selection", {
      providerId: "tapd",
      externalIds: ["50396062"],
    });
    expect(await screen.findByRole("region", { name: "工作项看板" })).toBeTruthy();
  });

  it("keeps checks on rediscovery and selects only filtered available projects", async () => {
    const user = userEvent.setup();
    const discovered = projectSelectionSnapshot().projectCatalog;
    const callTool = vi.fn().mockResolvedValue({ content: [], structuredContent: discovered });
    render(<App initialSnapshot={projectSelectionSnapshot()} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("checkbox", { name: "选择项目：ABF 产品研发" }));
    await user.click(screen.getByRole("button", { name: "重新发现项目" }));
    expect((screen.getByRole("checkbox", { name: "选择项目：ABF 产品研发" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "选择项目：历史项目" }) as HTMLInputElement).disabled).toBe(true);

    await user.type(screen.getByRole("searchbox", { name: "搜索项目" }), "学科");
    await user.click(screen.getByRole("checkbox", { name: "选择当前筛选结果" }));
    expect((screen.getByRole("checkbox", { name: "选择项目：学科工具" }) as HTMLInputElement).checked).toBe(true);
  });

  it("adds a project manually and stays in selection when save fails", async () => {
    const user = userEvent.setup();
    const added = {
      ...projectSelectionSnapshot().projectCatalog,
      projects: [
        ...projectSelectionSnapshot().projectCatalog.projects,
        {
          providerId: "tapd", externalId: "9001", name: "手工项目",
          selected: false, available: true, source: "manual" as const,
          lastVerifiedAt: "2026-08-07T00:00:00.000Z",
        },
      ],
    };
    const callTool = vi.fn(async (name: string) => {
      if (name === "add_project") return { content: [], structuredContent: added };
      if (name === "save_project_selection") throw new Error("save failed");
      return { content: [], structuredContent: projectSelectionSnapshot().projectCatalog };
    });
    render(<App initialSnapshot={projectSelectionSnapshot()} bridge={createBridge({ callTool })} />);

    await user.type(screen.getByLabelText("项目 ID 或 URL"), "https://www.tapd.cn/9001");
    await user.click(screen.getByRole("button", { name: "添加项目" }));
    expect(await screen.findByText("手工项目")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "选择项目：手工项目" }));
    await user.click(screen.getByRole("button", { name: "使用 1 个项目" }));
    expect(await screen.findByText("项目选择保存失败，请重试")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "选择项目" })).toBeTruthy();
  });

  it("returns from the board to project management", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge()} />);

    await user.click(screen.getByRole("button", { name: "管理项目" }));
    expect(screen.getByRole("heading", { name: "选择项目" })).toBeTruthy();
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
});
