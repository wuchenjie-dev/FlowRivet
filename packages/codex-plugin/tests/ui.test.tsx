// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskboardPreferences } from "../src/contracts/taskboard-preferences.js";
import type { TaskboardSnapshot } from "../src/contracts/taskboard.js";
import type { ProviderLoginSnapshot } from "../src/contracts/providers.js";
import type { WorkItemDetail } from "../src/contracts/work-item-detail.js";
import { demoTaskboardSnapshot } from "../src/demo/fixtures.js";
import { App } from "../src/ui/App.js";
import type { McpAppsBridge } from "../src/ui/bridge.js";
import { RepositoryDialog } from "../src/ui/components/RepositoryDialog.js";
import { ExecutionSummary } from "../src/ui/components/ExecutionSummary.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function createBridge(
  overrides: Partial<McpAppsBridge> = {},
  preferences: {
    get?: () => Promise<TaskboardPreferences>;
    save?: (value: TaskboardPreferences) => Promise<TaskboardPreferences>;
  } = {},
): McpAppsBridge {
  const delegatedCallTool = overrides.callTool;
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    canSendMessage: vi.fn(() => true),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    getDisplayState: vi.fn(() => ({ canFullscreen: true, isFullscreen: false })),
    requestFullscreen: vi.fn().mockResolvedValue({ canFullscreen: true, isFullscreen: true }),
    onToolResult: vi.fn(() => () => undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
    callTool: vi.fn(async (name: string, arguments_: Record<string, unknown>) => {
      if (name === "get_taskboard_preferences") {
        return {
          content: [],
          structuredContent: await (preferences.get?.()
            ?? Promise.resolve({ refreshIntervalSeconds: 60 })),
        };
      }
      if (name === "save_taskboard_preferences") {
        const value = arguments_ as TaskboardPreferences;
        return {
          content: [],
          structuredContent: await (preferences.save?.(value) ?? Promise.resolve(value)),
        };
      }
      return delegatedCallTool
        ? delegatedCallTool(name, arguments_)
        : {
            content: [],
            structuredContent: { ok: true, repliedAt: "2026-08-06T12:00:00.000Z" },
          };
    }),
  };
}

function snapshotWithTapdState(
  state: TaskboardSnapshot["connection"]["provider"]["state"],
): TaskboardSnapshot {
  return {
    ...demoTaskboardSnapshot,
    connection: {
      ...demoTaskboardSnapshot.connection,
      provider: {
        ...demoTaskboardSnapshot.connection.provider,
        state,
      },
    },
  };
}

function snapshotWithFeishuState(
  state: TaskboardSnapshot["connection"]["provider"]["state"],
): TaskboardSnapshot {
  const projectIds = ["PROJ-A", "PROJ-B"];
  return {
    ...demoTaskboardSnapshot,
    connection: {
      ...demoTaskboardSnapshot.connection,
      provider: {
        providerId: "feishu-project",
        displayName: "飞书项目",
        state,
        profileName: "default",
        ...(state === "connected" ? { accountDisplayName: "Example User" } : {}),
      },
    },
    projectCatalog: {
      ...demoTaskboardSnapshot.projectCatalog,
      provider: {
        providerId: "feishu-project",
        displayName: "飞书项目",
        state,
        profileName: "default",
      },
      projects: demoTaskboardSnapshot.projectCatalog.projects.map((project, index) => ({
        ...project,
        providerId: "feishu-project",
        externalId: projectIds[index]!,
      })),
    },
    projects: demoTaskboardSnapshot.projects.map((project, index) => ({
      ...project,
      providerId: "feishu-project",
      externalId: projectIds[index]!,
    })),
    items: demoTaskboardSnapshot.items.map((item, index) => ({
      ...item,
      key: `feishu-project:${projectIds[index % projectIds.length]}:work_item:${index + 1}`,
      providerId: "feishu-project",
      projectExternalId: projectIds[index % projectIds.length]!,
      externalUrl: `https://project.feishu.cn/example/work_item/${index + 1}`,
    })),
  };
}

function providerLoginSession(
  state: ProviderLoginSnapshot["state"],
  overrides: Partial<ProviderLoginSnapshot> = {},
): ProviderLoginSnapshot {
  const now = Date.now();
  return {
    sessionId: "login-example",
    providerId: "feishu-project",
    state,
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    browserLaunch: "opened",
    ...overrides,
  };
}

function offlineSnapshot(): TaskboardSnapshot {
  return {
    ...snapshotWithTapdState("expired"),
    dataFreshness: "offline",
    freshScopeCount: 0,
    staleScopeCount: 2,
    lastSuccessfulSyncAt: "2026-08-06T12:00:00.000Z",
    items: demoTaskboardSnapshot.items.map((item) => ({
      ...item,
      freshness: "cached",
    })),
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
  it("refreshes a connected Feishu board once when an existing app is reopened", async () => {
    const initial = snapshotWithFeishuState("connected");
    initial.items = initial.items.map((item, index) => ({
      ...item,
      title: `旧待办 ${index + 1}`,
    }));
    const refreshed = snapshotWithFeishuState("connected");
    refreshed.items = refreshed.items.map((item, index) => ({
      ...item,
      title: `最新待办 ${index + 1}`,
    }));
    const callTool = vi.fn(async (name: string) => ({
      content: [],
      structuredContent: name === "refresh_my_work_items"
        ? refreshed
        : { version: "0.1.0", protocolVersion: 1, uiVersion: "0.1.0" },
    }));

    render(<App
      initialSnapshot={initial}
      bridge={createBridge({ callTool }, {
        get: vi.fn().mockResolvedValue({ refreshIntervalSeconds: 0 }),
      })}
    />);

    expect(screen.getByText("旧待办 1")).toBeTruthy();
    expect(await screen.findByText("最新待办 1")).toBeTruthy();
    expect(callTool.mock.calls.filter(([name]) => name === "refresh_my_work_items"))
      .toHaveLength(1);
  });

  it("applies a newer host snapshot to an already mounted taskboard", async () => {
    const initial = snapshotWithFeishuState("connected");
    initial.items = initial.items.map((item, index) => ({
      ...item,
      title: `旧工具结果 ${index + 1}`,
    }));
    const updated = snapshotWithFeishuState("connected");
    updated.items = updated.items.map((item, index) => ({
      ...item,
      title: `新工具结果 ${index + 1}`,
    }));
    const refresh = deferred<{
      content: never[];
      structuredContent: TaskboardSnapshot;
    }>();
    const callTool = vi.fn(async (name: string) => name === "refresh_my_work_items"
      ? refresh.promise
      : {
          content: [],
          structuredContent: { version: "0.1.0", protocolVersion: 1, uiVersion: "0.1.0" },
        });
    const bridge = createBridge({ callTool });
    const view = render(<App initialSnapshot={initial} bridge={bridge} />);

    expect(screen.getByText("旧工具结果 1")).toBeTruthy();
    view.rerender(<App initialSnapshot={updated} bridge={bridge} />);

    expect(await screen.findByText("新工具结果 1")).toBeTruthy();
  });

  it("starts one-click Feishu authorization without a token or verification code", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn(async (name: string) => {
      if (name === "get_provider_login") {
        return { content: [], structuredContent: { requestId: "req-get" } };
      }
      if (name === "start_provider_login") {
        return {
          content: [],
          structuredContent: {
            requestId: "req-start",
            session: providerLoginSession("waiting"),
          },
        };
      }
      return { content: [], structuredContent: snapshotWithFeishuState("disconnected") };
    });
    render(<App
      initialSnapshot={snapshotWithFeishuState("disconnected")}
      bridge={createBridge({ callTool })}
    />);

    expect(screen.queryByLabelText(/Token/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "连接飞书项目" }));

    expect(await screen.findByRole("heading", { name: "请在浏览器中完成飞书授权" })).toBeTruthy();
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    expect(screen.queryByRole("button", { name: /检查.*结果/ })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(callTool).toHaveBeenCalledWith("start_provider_login", {});
    expect(document.body.textContent).not.toContain("login-example");
  });

  it("loads the board automatically after Feishu authorization completes", async () => {
    const user = userEvent.setup();
    const connected = snapshotWithFeishuState("connected");
    const callTool = vi.fn(async (name: string) => {
      if (name === "get_provider_login") {
        return { content: [], structuredContent: { requestId: "req-get" } };
      }
      if (name === "start_provider_login") {
        return {
          content: [],
          structuredContent: {
            requestId: "req-start",
            session: providerLoginSession("succeeded"),
          },
        };
      }
      if (name === "get_provider_connection") {
        return { content: [], structuredContent: connected.connection.provider };
      }
      return { content: [], structuredContent: connected };
    });
    render(<App
      initialSnapshot={snapshotWithFeishuState("disconnected")}
      bridge={createBridge({ callTool })}
    />);

    await user.click(screen.getByRole("button", { name: "连接飞书项目" }));

    expect(await screen.findByRole("region", { name: "工作项看板" })).toBeTruthy();
    expect(callTool).toHaveBeenCalledWith("get_provider_connection", {});
    expect(callTool).toHaveBeenCalledWith("open_my_taskboard", {});
  });

  it("shows a temporary manual fallback only when the system browser cannot open", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn(async (name: string) => ({
      content: [],
      structuredContent: name === "get_provider_login"
        ? { requestId: "req-get" }
        : {
            requestId: "req-start",
            session: providerLoginSession("waiting", {
              browserLaunch: "manual_required",
              error: {
                code: "provider_browser_launch_failed",
                retryable: true,
                recoveryAction: "open_manually",
                requestId: "req-start",
              },
              manualFallback: {
                verificationUri: "https://open.feishu.cn/device?code=example",
                userCode: "ABCD-EFGH",
              },
            }),
          },
    }));
    render(<App
      initialSnapshot={snapshotWithFeishuState("disconnected")}
      bridge={createBridge({ callTool })}
    />);

    await user.click(screen.getByRole("button", { name: "连接飞书项目" }));

    expect(await screen.findByRole("link", { name: "打开临时授权页" })).toMatchObject({
      target: "_blank",
      rel: "noreferrer",
    });
    expect(screen.getByLabelText("飞书备用授权码").textContent).toBe("ABCD-EFGH");
    expect(screen.getByRole("button", { name: "复制飞书备用授权码" })).toBeTruthy();
  });

  it("cancels an in-progress Feishu authorization", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn(async (name: string) => {
      if (name === "get_provider_login") {
        return { content: [], structuredContent: { requestId: "req-get" } };
      }
      if (name === "start_provider_login") return {
          content: [],
          structuredContent: {
            requestId: "req-start",
            session: providerLoginSession("waiting"),
          },
        };
      return {
        content: [],
        structuredContent: {
          requestId: "req-cancel",
          session: providerLoginSession("cancelled"),
        },
      };
    });
    render(<App
      initialSnapshot={snapshotWithFeishuState("disconnected")}
      bridge={createBridge({ callTool })}
    />);

    await user.click(screen.getByRole("button", { name: "连接飞书项目" }));
    await user.click(await screen.findByRole("button", { name: "取消授权" }));

    expect(await screen.findByRole("button", { name: "重新授权" })).toBeTruthy();
    expect(callTool).toHaveBeenCalledWith("cancel_provider_login", {
      sessionId: "login-example",
    });
  });

  it("keeps cached Feishu work visible behind the reconnect dialog", async () => {
    const user = userEvent.setup();
    const cached = snapshotWithFeishuState("expired");
    cached.dataFreshness = "offline";
    cached.freshScopeCount = 0;
    cached.staleScopeCount = 2;
    cached.items = cached.items.map((item) => ({ ...item, freshness: "cached" }));
    const callTool = vi.fn(async (name: string) => ({
      content: [],
      structuredContent: name === "get_provider_login"
        ? { requestId: "req-get" }
        : { requestId: "req-start", session: providerLoginSession("waiting") },
    }));
    render(<App initialSnapshot={cached} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", { name: "重新连接飞书项目" }));

    expect(await screen.findByRole("dialog", { name: "重新连接飞书项目" })).toBeTruthy();
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    expect(screen.getByRole("region", { name: "工作项看板" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "关闭飞书授权" }));
    expect(screen.queryByRole("dialog", { name: "重新连接飞书项目" })).toBeNull();
    expect(screen.getByText("飞书项目 授权中")).toBeTruthy();
    const reconnectButton = screen.getByRole("button", { name: "重新连接飞书项目" });
    await vi.waitFor(() => expect(document.activeElement).toBe(reconnectButton));
  });

  it("shows a bounded local CLI recovery when Feishu CLI is missing", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn().mockResolvedValue({
      content: [],
      structuredContent: snapshotWithFeishuState("cli_missing").connection.provider,
    });
    render(<App
      initialSnapshot={snapshotWithFeishuState("cli_missing")}
      bridge={createBridge({ callTool })}
    />);

    expect(screen.getByText("npx -y @lark-project/meegle@latest install")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重新检查飞书项目连接" }));
    expect(callTool).toHaveBeenCalledWith("get_provider_connection", {});
  });

  it("disconnects Feishu through the provider-neutral tool", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn().mockResolvedValue({
      content: [],
      structuredContent: snapshotWithFeishuState("disconnected").connection.provider,
    });
    render(<App
      initialSnapshot={snapshotWithFeishuState("connected")}
      bridge={createBridge({ callTool })}
    />);

    await user.click(screen.getByRole("button", { name: "打开连接菜单" }));
    await user.click(screen.getByRole("button", { name: "断开飞书项目" }));

    await vi.waitFor(() => expect(callTool).toHaveBeenCalledWith("disconnect_provider", {}));
    expect(await screen.findByRole("button", { name: "连接飞书项目" })).toBeTruthy();
  });

  it("starts and resumes a stable Codex handoff from a Feishu work item", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotWithFeishuState("connected");
    const execution = {
      schemaVersion: 2, executionId: "execution-1", providerId: "feishu-project",
      accountKey: "user-1", workItemKey: snapshot.items[0]!.key, taskLaunchMode: "handoff",
      attempt: 1, workMode: "non_code", codexHandoffId: "flowrivet-execution-1", executionKind: "requirement_analysis",
      state: "prepared", artifacts: [], createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    const callTool = vi.fn(async (name: string) => ({ content: [], structuredContent: name === "prepare_work_item_execution"
      ? { execution, handoff: { handoffId: "flowrivet-execution-1", prompt: "Continue FlowRivet work" } }
      : { ok: true } }));
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    render(<App initialSnapshot={snapshot} bridge={createBridge({ callTool, sendUserMessage })} />);

    await user.click(screen.getByRole("button", {
      name: `打开工作项：${snapshot.items[0]!.title}`,
    }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(callTool).toHaveBeenCalledWith("get_work_item_detail", {
      providerId: snapshot.items[0]!.providerId,
      projectExternalId: snapshot.items[0]!.projectExternalId,
      providerItemType: snapshot.items[0]!.providerItemType,
      externalId: snapshot.items[0]!.externalId,
    });
    await user.click(screen.getByRole("button", { name: "交给 Codex 处理" }));
    expect(callTool).toHaveBeenCalledWith("prepare_work_item_execution", { item: snapshot.items[0] });
    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(sendUserMessage).toHaveBeenCalledWith("Continue FlowRivet work");
    expect(await screen.findByRole("button", { name: "继续由 Codex 处理" })).toBeTruthy();
    expect(screen.getByText("execution-1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "兼容复制到 Codex" })).toBeNull();
  });

  it("keeps the execution retryable when the host rejects direct handoff", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotWithFeishuState("connected");
    const execution = {
      schemaVersion: 2, executionId: "execution-1", providerId: "feishu-project",
      accountKey: "user-1", workItemKey: snapshot.items[0]!.key, taskLaunchMode: "handoff",
      attempt: 1, workMode: "pending", codexHandoffId: "flowrivet-execution-1", executionKind: "pending_classification",
      state: "prepared", artifacts: [], createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    const callTool = vi.fn(async (name: string) => ({ content: [], structuredContent:
      name === "prepare_work_item_execution"
        ? { execution, handoff: { handoffId: "flowrivet-execution-1", prompt: "Continue safely" } }
        : { ok: true } }));
    const sendUserMessage = vi.fn().mockRejectedValue(new Error("codex_handoff_unsupported"));
    render(<App initialSnapshot={snapshot} bridge={createBridge({ callTool, sendUserMessage })} />);
    await user.click(screen.getByRole("button", { name: `打开工作项：${snapshot.items[0]!.title}` }));

    await user.click(screen.getByRole("button", { name: "交给 Codex 处理" }));

    expect(await screen.findByText("当前 Codex 版本不支持直接接管，可使用兼容复制")).toBeTruthy();
    expect(screen.getByRole("button", { name: "兼容复制到 Codex" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "继续由 Codex 处理" }));
    expect(callTool.mock.calls.filter(([name]) => name === "prepare_work_item_execution")).toHaveLength(1);
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("opens repository selection only after an execution is prepared", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotWithFeishuState("connected");
    const execution = {
      schemaVersion: 2, executionId: "execution-1", providerId: "feishu-project",
      accountKey: "user-1", workItemKey: snapshot.items[0]!.key, taskLaunchMode: "handoff",
      attempt: 1, workMode: "pending", codexHandoffId: "flowrivet-execution-1", executionKind: "pending_classification",
      state: "prepared", artifacts: [], createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    const project = { host: "gitlab-aiabu.ruijie.com.cn", projectId: "1", pathWithNamespace: "cc/flowrivet", displayName: "FlowRivet", defaultBranch: "main", httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git" };
    const callTool = vi.fn(async (name: string) => ({ content: [], structuredContent:
      name === "prepare_work_item_execution" ? { execution, handoff: { handoffId: "flowrivet-execution-1", prompt: "Continue" } }
        : name === "list_gitlab_projects" ? { page: 1, hasMore: false, projects: [project] }
          : { ...execution, state: "ready", gitlab: { host: project.host, projectId: "1", projectPath: "cc/flowrivet", localPath: "C:\\work\\flowrivet" } } }));
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);
    render(<App initialSnapshot={snapshot} bridge={createBridge({ callTool, sendUserMessage })} />);
    await user.click(screen.getByRole("button", { name: `打开工作项：${snapshot.items[0]!.title}` }));
    expect(screen.queryByText("选择研发仓库")).toBeNull();
    await user.click(screen.getByRole("button", { name: "交给 Codex 处理" }));
    await user.click(await screen.findByRole("button", { name: "关联研发仓库" }));
    const repositoryDialog = await screen.findByRole("dialog", { name: "选择研发仓库" });
    const detailDialog = screen.getByRole("dialog", { name: snapshot.items[0]!.title });
    expect(detailDialog.contains(repositoryDialog)).toBe(false);
    await user.click(screen.getByRole("option", { name: /cc\/flowrivet/ }));
    await user.type(screen.getByLabelText("本地仓库绝对路径"), "C:\\work\\flowrivet");
    await user.click(screen.getByRole("button", { name: "确认关联" }));
    expect(callTool).toHaveBeenCalledWith("bind_execution_repository", expect.objectContaining({ executionId: "execution-1", localPath: "C:\\work\\flowrivet" }));
    expect(sendUserMessage).toHaveBeenLastCalledWith("继续 FlowRivet 执行：execution-1");
  });

  it("selects existing repository and clone parent directories without submitting", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotWithFeishuState("connected");
    const execution = {
      schemaVersion: 2, executionId: "execution-directory", providerId: "feishu-project",
      accountKey: "user-1", workItemKey: snapshot.items[0]!.key, taskLaunchMode: "handoff",
      attempt: 1, workMode: "code", codexHandoffId: "flowrivet-execution-directory", executionKind: "development",
      state: "prepared", artifacts: [], createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    const project = { host: "gitlab-aiabu.ruijie.com.cn", projectId: "1", pathWithNamespace: "cc/flowrivet", displayName: "FlowRivet", defaultBranch: "main", httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git" };
    const callTool = vi.fn(async (name: string, arguments_: Record<string, unknown>) => ({
      content: [],
      structuredContent: name === "prepare_work_item_execution"
        ? { execution, handoff: { handoffId: "flowrivet-execution-directory", prompt: "Continue" } }
        : name === "list_gitlab_projects"
          ? { page: 1, hasMore: false, projects: [project] }
          : name === "select_local_directory"
            ? arguments_.purpose === "existing_repository"
              ? { outcome: "selected", absolutePath: "C:\\work\\flowrivet" }
              : { outcome: "selected", absolutePath: "C:\\work" }
            : { ok: true },
    }));
    render(<App initialSnapshot={snapshot} bridge={createBridge({ callTool })} />);
    await user.click(screen.getByRole("button", { name: `打开工作项：${snapshot.items[0]!.title}` }));
    await user.click(screen.getByRole("button", { name: "交给 Codex 处理" }));
    await user.click(await screen.findByRole("button", { name: "关联研发仓库" }));
    await user.click(screen.getByRole("option", { name: /cc\/flowrivet/ }));

    const existingButton = screen.getByRole("button", { name: "选择本地仓库文件夹" });
    expect(existingButton.getAttribute("title")).toBe("选择本地仓库文件夹");
    await user.click(existingButton);
    expect(callTool).toHaveBeenCalledWith("select_local_directory", { purpose: "existing_repository" });
    expect((screen.getByLabelText("本地仓库绝对路径") as HTMLInputElement).value).toBe("C:\\work\\flowrivet");
    expect(screen.getByRole("dialog", { name: "选择研发仓库" })
      .querySelector(".repository-directory-success")?.textContent).toContain("目录已选择");
    expect(callTool.mock.calls.some(([name]) => name === "bind_execution_repository")).toBe(false);

    await user.click(screen.getByRole("button", { name: "克隆到父目录" }));
    const cloneButton = screen.getByRole("button", { name: "选择克隆父文件夹" });
    expect(cloneButton.getAttribute("title")).toBe("选择克隆父文件夹");
    await user.click(cloneButton);
    expect(callTool).toHaveBeenCalledWith("select_local_directory", { purpose: "clone_parent" });
    expect((screen.getByLabelText("父目录绝对路径") as HTMLInputElement).value).toBe("C:\\work");
  });

  it("keeps manual paths on directory picker cancel and failure", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotWithFeishuState("connected");
    const execution = {
      schemaVersion: 2, executionId: "execution-directory-error", providerId: "feishu-project",
      accountKey: "user-1", workItemKey: snapshot.items[0]!.key, taskLaunchMode: "handoff",
      attempt: 1, workMode: "code", codexHandoffId: "flowrivet-execution-directory-error", executionKind: "development",
      state: "prepared", artifacts: [], createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    };
    const project = { host: "gitlab-aiabu.ruijie.com.cn", projectId: "1", pathWithNamespace: "cc/flowrivet", displayName: "FlowRivet", defaultBranch: "main", httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git" };
    let selectionAttempt = 0;
    const callTool = vi.fn(async (name: string) => {
      if (name === "prepare_work_item_execution") return { content: [], structuredContent: { execution, handoff: { handoffId: "flowrivet-execution-directory-error", prompt: "Continue" } } };
      if (name === "list_gitlab_projects") return { content: [], structuredContent: { page: 1, hasMore: false, projects: [project] } };
      if (name === "select_local_directory") {
        selectionAttempt += 1;
        if (selectionAttempt === 1) return { content: [], structuredContent: { outcome: "cancelled" } };
        throw new Error("directory_picker_unavailable");
      }
      return { content: [], structuredContent: { ok: true } };
    });
    render(<App initialSnapshot={snapshot} bridge={createBridge({ callTool })} />);
    await user.click(screen.getByRole("button", { name: `打开工作项：${snapshot.items[0]!.title}` }));
    await user.click(screen.getByRole("button", { name: "交给 Codex 处理" }));
    await user.click(await screen.findByRole("button", { name: "关联研发仓库" }));

    const input = screen.getByLabelText("本地仓库绝对路径");
    await user.type(input, "C:\\manual\\repository");
    await user.click(screen.getByRole("button", { name: "选择本地仓库文件夹" }));
    expect((input as HTMLInputElement).value).toBe("C:\\manual\\repository");
    await user.click(screen.getByRole("button", { name: "选择本地仓库文件夹" }));
    const pickerError = await screen.findByText("无法打开文件夹选择器，请手动输入绝对路径");
    expect(pickerError.getAttribute("role")).toBe("alert");
    expect((input as HTMLInputElement).value).toBe("C:\\manual\\repository");
    expect((input as HTMLInputElement).disabled).toBe(false);
  });

  it("ignores a directory selection that finishes after the preparation mode changes", async () => {
    const user = userEvent.setup();
    let finishSelection: ((value: { outcome: "selected"; absolutePath: string }) => void) | undefined;
    const onSelectDirectory = vi.fn(() => new Promise<{ outcome: "selected"; absolutePath: string }>((resolve) => {
      finishSelection = resolve;
    }));
    render(<RepositoryDialog
      projects={[]}
      pending={false}
      onBind={vi.fn()}
      onCancel={vi.fn()}
      onSelectDirectory={onSelectDirectory}
    />);

    await user.click(screen.getByRole("button", { name: "选择本地仓库文件夹" }));
    expect(screen.getByRole("button", { name: "选择本地仓库文件夹" }).getAttribute("aria-busy")).toBe("true");
    await user.click(screen.getByRole("button", { name: "克隆到父目录" }));
    finishSelection?.({ outcome: "selected", absolutePath: "C:\\stale\\repository" });
    await act(async () => undefined);

    expect((screen.getByLabelText("父目录绝对路径") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "选择克隆父文件夹" }).getAttribute("aria-busy")).toBe("false");
  });

  it("restores an existing repository and reopens the picker at its current path", async () => {
    const user = userEvent.setup();
    const project = { host: "gitlab-aiabu.ruijie.com.cn", projectId: "1", pathWithNamespace: "cc/flowrivet", displayName: "FlowRivet", defaultBranch: "main", httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git" } as const;
    const onSelectDirectory = vi.fn().mockResolvedValue({ outcome: "cancelled" });
    render(<RepositoryDialog
      projects={[project]}
      initialProject={project}
      initialRepository={{ host: project.host, projectId: "1", projectPath: "cc/flowrivet", localPath: "C:\\work\\flowrivet" }}
      pending={false}
      onBind={vi.fn()}
      onCancel={vi.fn()}
      onSelectDirectory={onSelectDirectory}
    />);

    expect(screen.getByRole("option", { name: /cc\/flowrivet/ }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("本地仓库绝对路径") as HTMLInputElement).value).toBe("C:\\work\\flowrivet");
    await user.click(screen.getByRole("button", { name: "选择本地仓库文件夹" }));
    expect(onSelectDirectory).toHaveBeenCalledWith("existing_repository", "C:\\work\\flowrivet");
  });

  it("allows repository changes before activity and explains the locked state afterwards", () => {
    const base = {
      execution: {
        schemaVersion: 2 as const, executionId: "execution-lock", providerId: "feishu-project" as const,
        accountKey: "user-1", workItemKey: "item-1", taskLaunchMode: "handoff" as const,
        attempt: 1, workMode: "code" as const, executionKind: "development" as const, state: "ready" as const, artifacts: [],
        createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
        gitlab: { host: "gitlab-aiabu.ruijie.com.cn" as const, projectId: "1", projectPath: "cc/flowrivet", localPath: "C:\\work\\flowrivet" },
      },
      handoff: { handoffId: "handoff-1", prompt: "Continue" },
    };
    const onSelectRepository = vi.fn();
    const { rerender } = render(<ExecutionSummary value={base} onSelectRepository={onSelectRepository} />);
    expect(screen.getByRole("status").textContent).toContain("仓库已关联");
    expect(screen.getByRole("button", { name: "修改仓库关联" }).hasAttribute("disabled")).toBe(false);

    rerender(<ExecutionSummary value={{ ...base, execution: { ...base.execution, gitlab: { ...base.execution.gitlab, branch: "codex/item-1" } } }} onSelectRepository={onSelectRepository} />);
    expect(screen.getByRole("button", { name: "仓库关联已锁定" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("已创建研发分支，仓库关联不可修改")).toBeTruthy();
  });

  it("recovers an associated project that is missing from the first project page", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotWithFeishuState("connected");
    const associatedProject = { host: "gitlab-aiabu.ruijie.com.cn", projectId: "75", pathWithNamespace: "cc/flowrivet", displayName: "FlowRivet", defaultBranch: "main", httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git" };
    const execution = {
      schemaVersion: 2, executionId: "execution-recovery", providerId: "feishu-project",
      accountKey: "user-1", workItemKey: snapshot.items[0]!.key, taskLaunchMode: "handoff",
      attempt: 1, workMode: "code", executionKind: "development", state: "ready", artifacts: [],
      createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
      gitlab: { host: associatedProject.host, projectId: "75", projectPath: "cc/flowrivet", localPath: "C:\\work\\flowrivet" },
    };
    const callTool = vi.fn(async (name: string) => ({ content: [], structuredContent:
      name === "get_work_item_execution" ? { execution }
        : name === "prepare_work_item_execution" ? { execution, handoff: { handoffId: "handoff-recovery", prompt: "Continue" } }
          : name === "list_gitlab_projects" ? { page: 1, hasMore: true, projects: [] }
            : name === "get_gitlab_project" ? associatedProject
              : { ...snapshot.items[0], assignees: [], descriptionTruncated: false } }));
    render(<App initialSnapshot={snapshot} bridge={createBridge({ callTool })} />);
    await user.click(screen.getByRole("button", { name: `打开工作项：${snapshot.items[0]!.title}` }));

    await user.click(await screen.findByRole("button", { name: "修改仓库关联" }));

    expect(callTool).toHaveBeenCalledWith("get_gitlab_project", { projectId: "75" });
    expect((await screen.findByRole("option", { name: /cc\/flowrivet/ })).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("本地仓库绝对路径") as HTMLInputElement).value).toBe("C:\\work\\flowrivet");
  });

  it("shows GitLab progress and an explicit local-only writeback state", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotWithFeishuState("connected");
    const mergeRequestUrl = "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet/-/merge_requests/9";
    const execution = {
      schemaVersion: 2, executionId: "execution-progress", providerId: "feishu-project",
      accountKey: "user-1", workItemKey: snapshot.items[0]!.key, taskLaunchMode: "handoff",
      attempt: 1, workMode: "code", codexHandoffId: "flowrivet-execution-progress", executionKind: "development",
      state: "writeback_pending", artifacts: [], createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      gitlab: {
        host: "gitlab-aiabu.ruijie.com.cn", projectId: "1",
        projectPath: "cc/a-very-long-flowrivet-project-name", localPath: "C:\\very\\long\\workspace\\flowrivet",
        branch: "codex/feishu-work-item-123", mergeRequestIid: 9,
        mergeRequestUrl, pipelineId: "42",
      },
    };
    const callTool = vi.fn(async (name: string) => ({ content: [], structuredContent:
      name === "get_work_item_execution"
        ? {}
        : { execution, handoff: { handoffId: "flowrivet-execution-progress", prompt: "Continue" } } }));
    render(<App initialSnapshot={snapshot} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", { name: `打开工作项：${snapshot.items[0]!.title}` }));
    await user.click(screen.getByRole("button", { name: "交给 Codex 处理" }));

    expect(await screen.findByText("研发实现")).toBeTruthy();
    expect(screen.getByText("尚未写回，结果已保存在本地")).toBeTruthy();
    expect(screen.getByRole("link", { name: /查看 MR/ }).getAttribute("href")).toBe(mergeRequestUrl);
    expect(screen.getByText("codex/feishu-work-item-123")).toBeTruthy();
  });

  it("does not render an unsafe Feishu work item URL", async () => {
    const user = userEvent.setup();
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const snapshot = snapshotWithFeishuState("connected");
    snapshot.items[0] = { ...snapshot.items[0]!, externalUrl: "http://example.test/item/1" };
    render(<App initialSnapshot={snapshot} bridge={createBridge()} />);

    await user.click(screen.getByRole("button", {
      name: `打开工作项：${snapshot.items[0].title}`,
    }));

    expect(opened).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /在飞书项目中打开/ })).toBeNull();
    opened.mockRestore();
  });
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

  it("keeps cached work visible while disconnected", () => {
    render(<App initialSnapshot={offlineSnapshot()} bridge={createBridge()} />);

    expect(screen.getByRole("region", { name: "工作项看板" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("离线缓存");
    expect(screen.getByRole("button", { name: "重新连接 TAPD" })).toBeTruthy();
    expect(screen.queryByLabelText("TAPD Token")).toBeNull();
  });

  it("names mixed data scope counts and marks cached cards without color alone", () => {
    render(<App initialSnapshot={{
      ...offlineSnapshot(),
      connection: {
        ...demoTaskboardSnapshot.connection,
        provider: {
          ...demoTaskboardSnapshot.connection.provider,
          state: "connected",
        },
      },
      dataFreshness: "mixed",
      freshScopeCount: 1,
      staleScopeCount: 2,
    }} bridge={createBridge()} />);

    expect(screen.getByRole("status").textContent).toContain("2 个范围使用缓存");
    expect(screen.getAllByText("缓存").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /打开缓存工作项/ }).length)
      .toBeGreaterThan(0);
  });

  it("closes reconnect with Escape, restores focus, and retains the cached board", async () => {
    const user = userEvent.setup();
    render(<App initialSnapshot={offlineSnapshot()} bridge={createBridge()} />);
    const opener = screen.getByRole("button", { name: "重新连接 TAPD" });

    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "重新连接 TAPD" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("TAPD Token"));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "重新连接 TAPD" })).toBeNull();
    expect(screen.getByRole("region", { name: "工作项看板" })).toBeTruthy();
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("refreshes the cached board after reconnecting", async () => {
    const user = userEvent.setup();
    const token = "replacement-token";
    const callTool = vi.fn(async (name: string) => {
      if (name === "login_with_tapd_token") {
        return {
          content: [],
          structuredContent: {
            ok: true,
            connection: { tapd: "connected", userName: "吴晨杰" },
          },
        };
      }
      return { content: [], structuredContent: demoTaskboardSnapshot };
    });
    render(<App initialSnapshot={offlineSnapshot()} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", { name: "重新连接 TAPD" }));
    await user.type(screen.getByLabelText("TAPD Token"), token);
    await user.click(screen.getByRole("button", { name: "提交并重新连接" }));

    await vi.waitFor(() => expect(callTool).toHaveBeenCalledWith(
      "login_with_tapd_token", { token },
    ));
    expect(await screen.findByText("TAPD 已连接，已同步 7 个工作项")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "重新连接 TAPD" })).toBeNull();
    expect(screen.getByRole("region", { name: "工作项看板" })).toBeTruthy();
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

  it("connects GitLab from the connection menu without asking for a token", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn(async (name: string) => ({
      content: [],
      structuredContent: name === "get_gitlab_connection"
        ? { host: "gitlab-aiabu.ruijie.com.cn", state: "disconnected", cliVersion: "1.113.0" }
        : name === "start_gitlab_login"
          ? { state: "waiting" }
          : { ok: true },
    }));
    render(<App initialSnapshot={demoTaskboardSnapshot} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", { name: "打开连接菜单" }));
    expect(await screen.findByText("GitLab")).toBeTruthy();
    expect(screen.queryByLabelText(/GitLab Token/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "连接 GitLab" }));
    expect(callTool).toHaveBeenCalledWith("start_gitlab_login", {});
    expect(await screen.findByText("请在浏览器完成 GitLab 授权")).toBeTruthy();
  });

  it("uses a 60 second cooldown for a full rate-limit MCP error", async () => {
    vi.useFakeTimers();
    const callTool = vi.fn(async (name: string) => name === "refresh_my_work_items"
      ? {
          content: [{ type: "text" as const, text: "provider_rate_limited" }],
          isError: true,
        }
      : { content: [], structuredContent: demoTaskboardSnapshot });
    render(<App
      initialSnapshot={demoTaskboardSnapshot}
      bridge={createBridge({
        callTool,
        getDisplayState: vi.fn(() => ({ canFullscreen: false, isFullscreen: false })),
      }, {
        get: vi.fn().mockResolvedValue({ refreshIntervalSeconds: 5 }),
      })}
    />);
    await act(async () => Promise.resolve());

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(callTool.mock.calls.filter(([name]) => name === "refresh_my_work_items"))
      .toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(59_999));
    expect(callTool.mock.calls.filter(([name]) => name === "refresh_my_work_items"))
      .toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(callTool.mock.calls.filter(([name]) => name === "refresh_my_work_items"))
      .toHaveLength(2);
  });

  it("loads and saves an auto-refresh preset from the connection menu", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async (value: TaskboardPreferences) => value);
    render(<App
      initialSnapshot={demoTaskboardSnapshot}
      bridge={createBridge({}, { save })}
    />);

    await user.click(screen.getByRole("button", { name: "打开连接菜单" }));
    expect((await screen.findByRole("menuitemradio", { name: "每 60 秒" }))
      .getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("menuitemradio", { name: "每 10 秒" }));

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({
      refreshIntervalSeconds: 10,
    }));
    expect(screen.getByRole("menuitemradio", { name: "每 10 秒" })
      .getAttribute("aria-checked")).toBe("true");
  });

  it("validates a custom interval and restores focus when the dialog closes", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async (value: TaskboardPreferences) => value);
    render(<App
      initialSnapshot={demoTaskboardSnapshot}
      bridge={createBridge({}, { save })}
    />);

    await user.click(screen.getByRole("button", { name: "打开连接菜单" }));
    const opener = await screen.findByRole("button", { name: "自定义刷新频率" });
    await user.click(opener);
    const input = screen.getByLabelText("刷新间隔（秒）") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await user.clear(input);
    await user.type(input, "4");
    expect((screen.getByRole("button", {
      name: "保存刷新频率",
    }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(input);
    await user.type(input, "3600");
    await user.click(screen.getByRole("button", { name: "保存刷新频率" }));

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({
      refreshIntervalSeconds: 3600,
    }));
    expect(screen.queryByRole("dialog", { name: "自定义刷新频率" })).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));

    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "自定义刷新频率" })).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("keeps the previous interval after a preference save failure", async () => {
    const user = userEvent.setup();
    render(<App
      initialSnapshot={demoTaskboardSnapshot}
      bridge={createBridge({}, {
        save: vi.fn().mockRejectedValue(new Error("taskboard_preferences_write_failed")),
      })}
    />);

    await user.click(screen.getByRole("button", { name: "打开连接菜单" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "每 10 秒" }));

    expect(await screen.findByText("无法保存自动刷新设置")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "每 60 秒" })
      .getAttribute("aria-checked")).toBe("true");
  });

  it("disables automatic refresh for the session when preferences cannot be read", async () => {
    render(<App
      initialSnapshot={demoTaskboardSnapshot}
      bridge={createBridge({}, {
        get: vi.fn().mockRejectedValue(new Error("taskboard_preferences_read_failed")),
      })}
    />);

    expect(await screen.findByText("无法读取自动刷新设置，本次会话已关闭自动刷新"))
      .toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "打开连接菜单" }));
    expect(screen.getByRole("menuitemradio", { name: "不自动刷新" })
      .getAttribute("aria-checked")).toBe("true");
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

  it("loads complete detail for a Feishu card instead of stopping at its summary", async () => {
    const user = userEvent.setup();
    const snapshot = snapshotWithFeishuState("connected");
    const item = snapshot.items[0]!;
    const detail = workItemDetail({
      key: item.key,
      providerId: "feishu-project",
      projectExternalId: item.projectExternalId,
      providerItemType: item.providerItemType,
      externalId: item.externalId,
      projectName: item.projectName,
      title: item.title,
      externalUrl: item.externalUrl,
      assignees: ["Example Owner"],
      startedAt: "2026-08-11T01:00:00.000Z",
    });
    const pending = deferred<{ content: []; structuredContent: WorkItemDetail }>();
    const callTool = vi.fn(async (name: string) => name === "get_work_item_detail"
      ? pending.promise
      : { content: [] as [], structuredContent: { version: "0.1.0", protocolVersion: 1, uiVersion: "0.1.0" } });
    render(<App initialSnapshot={snapshot} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", { name: `打开工作项：${item.title}` }));

    expect(screen.getByText("正在加载工作项详情")).toBeTruthy();
    pending.resolve({ content: [], structuredContent: detail });
    const dialog = await screen.findByRole("dialog", { name: item.title });
    expect(callTool).toHaveBeenCalledWith("get_work_item_detail", {
      providerId: "feishu-project",
      projectExternalId: item.projectExternalId,
      providerItemType: item.providerItemType,
      externalId: item.externalId,
    });
    expect(within(dialog).getByText("Example Owner")).toBeTruthy();
    expect(within(dialog).getByText("开始时间")).toBeTruthy();
  });

  it("shows loading state and a retryable provider error", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ content: []; structuredContent: WorkItemDetail }>();
    let detailCalls = 0;
    const callTool = vi.fn(async (name: string) => {
      if (name === "get_runtime_version") {
        return { content: [], structuredContent: { version: "0.1.0", protocolVersion: 1, uiVersion: "0.1.0" } };
      }
      detailCalls += 1;
      return detailCalls === 1
        ? pending.promise
        : { content: [] as [], structuredContent: workItemDetail() };
    });
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
    expect(callTool.mock.calls.filter(([name]) => name === "get_work_item_detail")).toHaveLength(2);
  });

  it("explains that offline detail requires reconnecting", async () => {
    const user = userEvent.setup();
    const callTool = vi.fn().mockRejectedValue(new Error("provider_not_connected"));
    render(<App initialSnapshot={offlineSnapshot()} bridge={createBridge({ callTool })} />);

    await user.click(screen.getByRole("button", {
      name: "打开缓存工作项：统一检索结果的排序与筛选体验",
    }));

    expect(await screen.findByText("重新连接后加载详情")).toBeTruthy();
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
