import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

import {
  CommandRunnerError,
  type CommandRunInput,
  type CommandRunResult,
} from "../src/meegle/command-runner.js";
import {
  MeegleCliClient,
  MeegleCliError,
  type MeegleCommandRunner,
} from "../src/meegle/meegle-cli-client.js";

class FakeRunner implements MeegleCommandRunner {
  readonly run = vi.fn<(input: CommandRunInput) => Promise<CommandRunResult>>();
}

function client(
  runner: FakeRunner,
  clock = () => new Date("2026-08-11T00:00:00.000Z"),
) {
  return new MeegleCliClient({
    runner,
    executableResolver: async () => "C:\\tools\\meegle.exe",
    clock,
  });
}

describe("Meegle CLI client", () => {
  it("parses the observed redacted recent-project response", async () => {
    const runner = new FakeRunner();
    const fixture = await readFile(new URL("./fixtures/meegle/project-search-page.json", import.meta.url), "utf8");
    runner.run.mockResolvedValue({ stdout: fixture, exitCode: 0 });

    await expect(client(runner).listRecentProjects("default")).resolves.toEqual([{
      name: "Redacted Project",
      project_key: "REDACTED_PROJECT_KEY",
      simple_name: "redacted-project",
    }]);
  });

  it("fully paginates the recent-project catalog with the verified 50-item boundary", async () => {
    const runner = new FakeRunner();
    const projects = Array.from({ length: 50 }, (_, index) => ({
      name: `Project ${index + 1}`,
      project_key: `PROJ${index + 1}`,
      simple_name: `project-${index + 1}`,
    }));
    runner.run
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          pagination: { has_more: true, page_num: 1, page_size: 50, total: 51 },
          projects,
        }), exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          pagination: { has_more: false, page_num: 2, page_size: 50, total: 51 },
          projects: [{ name: "Last", project_key: "LAST", simple_name: "last" }],
        }), exitCode: 0,
      });

    await expect(client(runner).listRecentProjects("default"))
      .resolves.toHaveLength(51);
    expect(runner.run.mock.calls.map(([input]) => input.args)).toEqual([
      ["project", "search", "--page-num", "1", "--profile", "default", "--format", "json"],
      ["project", "search", "--page-num", "2", "--profile", "default", "--format", "json"],
    ]);
  });

  it("parses work item types and the observed moql_field_list query response", async () => {
    const runner = new FakeRunner();
    const queryFixture = await readFile(new URL("./fixtures/meegle/created-query-page.json", import.meta.url), "utf8");
    const typeFixture = await readFile(new URL("./fixtures/meegle/meta-types.json", import.meta.url), "utf8");
    runner.run
      .mockResolvedValueOnce({ stdout: typeFixture, exitCode: 0 })
      .mockResolvedValueOnce({ stdout: queryFixture, exitCode: 0 });
    const meegle = client(runner);
    const project = { name: "Project", project_key: "PROJ", simple_name: "project" };
    const type = { api_name: "redacted_type", enable_model_resource_lib: false, is_disable: 2, name: "Redacted Type", type_key: "REDACTED_TYPE_KEY" };

    await expect(meegle.listWorkItemTypes("default", "PROJ")).resolves.toEqual([type]);
    const page = await meegle.queryCreatedWorkItems("default", project, type);

    expect(page.data["1"]?.[0]?.moql_field_list).toHaveLength(4);
    expect(runner.run.mock.calls[1]![0].args).toEqual([
      "workitem", "query", "--project-key", "PROJ",
      "--mql", "SELECT `work_item_id`, `name`, `work_item_status`, `完成时间` FROM `Project`.`Redacted Type` WHERE `·创建者` = current_login_user()",
      "--profile", "default", "--format", "json",
    ]);
  });

  it("parses the observed strict no-match created-items response", async () => {
    const runner = new FakeRunner();
    const emptyFixture = await readFile(new URL("./fixtures/meegle/created-query-empty.json", import.meta.url), "utf8");
    runner.run.mockResolvedValue({ stdout: emptyFixture, exitCode: 0 });
    const project = { name: "Project", project_key: "PROJ", simple_name: "project" };
    const type = { api_name: "solution", enable_model_resource_lib: false, is_disable: 2, name: "Solution", type_key: "solution-key" };

    await expect(client(runner).queryCreatedWorkItems("default", project, type))
      .resolves.toMatchObject({ data: {}, list: null });
  });

  it.each([
    {
      data: {},
      list: [{ count: 0, group_infos: [{ group_id: "1", group_name: "Group" }] }],
    },
    {
      data: { "1": [] },
      list: null,
    },
  ])("rejects inconsistent empty created-items response variants", async ({ data, list }) => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({
        data, extra_info: null, list, search_status_info: null, session_id: "session-1",
      }),
      exitCode: 0,
    });
    const project = { name: "Project", project_key: "PROJ", simple_name: "project" };
    const type = { api_name: "solution", enable_model_resource_lib: false, is_disable: 2, name: "Solution", type_key: "solution-key" };

    await expect(client(runner).queryCreatedWorkItems("default", project, type))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("rejects unsafe authoritative MQL identifiers before invoking the runner", async () => {
    const runner = new FakeRunner();
    const project = { name: "Project` UNION", project_key: "PROJ", simple_name: "project" };
    const type = { api_name: "story", enable_model_resource_lib: false, is_disable: 2, name: "Story", type_key: "story" };

    await expect(client(runner).queryCreatedWorkItems("default", project, type))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("fails closed on inconsistent recent-project pagination and catalog limits", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({
        pagination: { has_more: true, page_num: 1, page_size: 50, total: 51 },
        projects: [],
      }), exitCode: 0,
    });

    await expect(client(runner).listRecentProjects("default"))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("rejects a recent-project total that changes between pages", async () => {
    const runner = new FakeRunner();
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      name: `Project ${index}`, project_key: `PROJ${index}`, simple_name: `project-${index}`,
    }));
    runner.run
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          pagination: { has_more: true, page_num: 1, page_size: 50, total: 100 },
          projects: firstPage,
        }), exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          pagination: { has_more: false, page_num: 2, page_size: 50, total: 51 },
          projects: [{ name: "Last", project_key: "LAST", simple_name: "last" }],
        }), exitCode: 0,
      });

    await expect(client(runner).listRecentProjects("default"))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });
  it("validates the minimum version and parses the bounded text profile", async () => {
    const runner = new FakeRunner();
    runner.run
      .mockResolvedValueOnce({ stdout: "meegle version 1.0.19\n", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "default\n", exitCode: 0 });
    const meegle = client(runner);

    await expect(meegle.getVersion()).resolves.toBe("1.0.19");
    await expect(meegle.getCurrentProfile()).resolves.toBe("default");
    expect(runner.run.mock.calls.map(([input]) => input.args)).toEqual([
      ["--version"],
      ["config", "profile", "current", "--format", "json"],
    ]);
  });

  it("rejects unsupported versions and malformed multiline profiles", async () => {
    const runner = new FakeRunner();
    runner.run
      .mockResolvedValueOnce({ stdout: "1.0.18", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "default\nother", exitCode: 0 });
    const meegle = client(runner);

    await expect(meegle.getVersion()).rejects.toMatchObject({ code: "provider_cli_unsupported" });
    await expect(meegle.getCurrentProfile()).rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("runs status, identity, logout, and paged work commands with a pinned profile", async () => {
    const runner = new FakeRunner();
    runner.run
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ authenticated: true, expires_in_minutes: 119, host: "project.feishu.cn" }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          avatar_url: "https://example.invalid/avatar.png",
          email: "user@example.invalid",
          name_cn: "Example User",
          name_en: "Example User",
          user_key: "user_example",
        }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: "{}", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ list: null, total: 0 }), exitCode: 0 });
    const meegle = client(runner);

    await expect(meegle.getAuthStatus("default")).resolves.toMatchObject({ authenticated: true });
    await expect(meegle.getCurrentUser("default")).resolves.toMatchObject({ user_key: "user_example" });
    await expect(meegle.logout("default")).resolves.toBeUndefined();
    await expect(meegle.getMyWorkPage("default", "this_week", 1)).resolves.toEqual({
      list: null,
      total: 0,
    });
    expect(runner.run.mock.calls.map(([input]) => input.args)).toEqual([
      ["auth", "status", "--profile", "default", "--format", "json"],
      ["user", "me", "--profile", "default", "--format", "json"],
      ["auth", "logout", "--profile", "default", "--format", "json"],
      ["mywork", "todo", "--action", "this_week", "--page-num", "1", "--profile", "default", "--format", "json"],
    ]);
  });

  it("requests the complete todo scope instead of the CLI in-progress default", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({ list: null, total: 0 }),
      exitCode: 0,
    });

    await expect(client(runner).getMyWorkPage("default", "todo", 1)).resolves.toEqual({
      list: null,
      total: 0,
    });
    expect(runner.run.mock.calls[0]![0].args).toEqual([
      "mywork", "todo", "--action", "todo", "--todo-scope", "all",
      "--page-num", "1", "--profile", "default", "--format", "json",
    ]);
  });

  it("resolves a project key to the canonical URL simple name", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({
        pagination: { has_more: false, page_num: 1, page_size: 50, total: 1 },
        projects: [{
          name: "Example Project",
          project_key: "PROJ",
          simple_name: "example-space",
        }],
      }),
      exitCode: 0,
    });

    await expect(client(runner).getProjectSimpleName("default", "PROJ"))
      .resolves.toBe("example-space");
    expect(runner.run.mock.calls[0]![0].args).toEqual([
      "project", "search",
      "--project-key", "PROJ",
      "--profile", "default",
      "--format", "json",
    ]);
  });

  it("reads all work item fields without the broken page-size flag", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({
        pagination: { has_more: false, page_size: 100, total: 0 },
        work_item_attribute: {
          create_by: { email: "creator@example.invalid", key: "creator", name: "Creator" },
          create_time: "2026-08-10T01:00:00Z",
          owned_project: { key: "PROJ", name: "Example Project", simple_name: "example-project" },
          template: { id: 1, name: "Template" },
          update_time: "2026-08-12T01:00:00Z",
          updated_by: { email: "updater@example.invalid", key: "updater", name: "Updater" },
          work_item_id: "10001", work_item_mod: "work_item", work_item_name: "Example",
          work_item_status: { key: "planning", name: "Planning" },
          work_item_type: { key: "story", name: "Requirement" },
        },
        work_item_fields: [],
      }),
      exitCode: 0,
    });

    await expect(client(runner).getWorkItem("default", "PROJ", "10001"))
      .resolves.toMatchObject({ work_item_fields: [] });
    expect(runner.run.mock.calls[0]![0].args).toEqual([
      "workitem", "get", "--project-key", "PROJ", "--work-item-id", "10001",
      "--fields", "_all", "--profile", "default", "--format", "json",
    ]);
    expect(runner.run.mock.calls[0]![0].args).not.toContain("--page-size");
  });

  it("reads exactly one work item field with the verified fields argv", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({
        pagination: { has_more: false, page_size: 100, total: 0 },
        work_item_attribute: {
          create_by: { key: "creator", name: "Creator", email: "" }, create_time: "now",
          owned_project: { key: "PROJ", name: "Project", simple_name: "project" },
          template: { id: 1, name: "Template" }, update_time: "now",
          updated_by: { key: "creator", name: "Creator", email: "" },
          work_item_id: "wi-1", work_item_mod: "work_item", work_item_name: "Item",
          work_item_status: { key: "open", name: "Open" },
          work_item_type: { key: "story", name: "Story" },
        },
        work_item_fields: [{ key: "result", name: "Result", value: "done" }],
      }), exitCode: 0,
    });

    await expect(client(runner).getWorkItemFields("profile", "PROJ", "wi-1", ["result"]))
      .resolves.toMatchObject({ work_item_fields: [{ key: "result", value: "done" }] });
    expect(runner.run.mock.calls[0]![0].args).toEqual([
      "workitem", "get", "--project-key", "PROJ", "--work-item-id", "wi-1",
      "--fields", "result", "--profile", "profile", "--format", "json",
    ]);
  });

  it("rejects unverified multi-field read formatting before running the CLI", async () => {
    const runner = new FakeRunner();
    await expect(client(runner).getWorkItemFields(
      "profile", "PROJ", "wi-1", ["result", "summary"],
    )).rejects.toMatchObject({ code: "provider_invalid_response" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("accepts additive detail fields from newer official CLI responses", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({
        pagination: { has_more: false, page_size: 100, total: 0 },
        work_item_attribute: {
          create_by: { email: "creator@example.invalid", key: "creator", name: "Creator" },
          create_time: "2026-08-10T01:00:00Z",
          owned_project: { key: "PROJ", name: "Example Project", simple_name: "example-project" },
          role_members: [{ key: "owner", name: "Example Owner" }],
          template: { id: 1, name: "Template" },
          update_time: "2026-08-12T01:00:00Z",
          updated_by: { email: "updater@example.invalid", key: "updater", name: "Updater" },
          work_item_id: "10001", work_item_mod: "work_item", work_item_name: "Example",
          work_item_status: { key: "planning", name: "Planning" },
          work_item_type: { key: "story", name: "Requirement" },
        },
        work_item_current_node: [{
          actual_begin_time: "2026-08-11T01:00:00Z",
          id: "node-1",
          name: "Planning",
          owners: [{ email: "owner@example.invalid", key: "owner", name: "Example Owner" }],
        }],
        work_item_fields: [
          { key: "priority", name: "Priority", value: { label: "High", value: "high" } },
          { key: "current_status_operator", name: "Assignee", value: [{ key: "owner", name: "Example Owner" }] },
        ],
      }),
      exitCode: 0,
    });

    const detail = await client(runner).getWorkItem("default", "PROJ", "10001");

    expect(detail.work_item_attribute.work_item_name).toBe("Example");
    expect(detail.work_item_fields.map((field) => field.value)).toEqual([
      '{"label":"High","value":"high"}',
      '[{"key":"owner","name":"Example Owner"}]',
    ]);
    expect(detail).not.toHaveProperty("work_item_current_node");
    expect(detail.work_item_attribute).not.toHaveProperty("role_members");
  });

  it("accepts structured unauthenticated status on exit one", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({
        authenticated: false,
        host: "project.feishu.cn",
        reason: "no local token",
      }),
      exitCode: 1,
    });

    await expect(client(runner).getAuthStatus()).resolves.toMatchObject({
      authenticated: false,
      reason: "no local token",
    });
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ allowExitCodes: [0, 1] }));
  });

  it("rejects invalid JSON and invalid response schemas", async () => {
    const runner = new FakeRunner();
    runner.run
      .mockResolvedValueOnce({ stdout: "not-json", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ list: [], total: -1 }), exitCode: 0 });
    const meegle = client(runner);

    await expect(meegle.getAuthStatus()).rejects.toMatchObject({ code: "provider_invalid_response" });
    await expect(meegle.getMyWorkPage("default", "done", 1))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("accepts present but empty state keys emitted by the official CLI", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({
        list: [{
          finish_time: { finish_time: "2026-08-10T08:30:00+08:00" },
          node_info: { node_name: "Done", node_state_key: "node_done" },
          project_key: "PROJ",
          project_name: "Example Project",
          schedule: null,
          state_info: { end_state_key_name: "", start_state_key_name: "" },
          work_item_info: {
            work_item_id: 10001,
            work_item_name: "Example item",
            work_item_type_key: "task",
          },
        }],
        total: 1,
      }),
      exitCode: 0,
    });

    await expect(client(runner).getMyWorkPage("default", "done", 1))
      .resolves.toMatchObject({ total: 1 });
  });

  it("initializes a device login for an explicit profile", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValueOnce({
      stdout: JSON.stringify({
        client_id: "client-example",
        device_code: "device-example",
        expires_in: 600,
        interval: 5,
        user_code: "USER-CODE",
        verification_uri: "https://open.feishu.cn/device",
        verification_uri_complete: "https://open.feishu.cn/device?code=example",
      }),
      exitCode: 0,
    });

    const attempt = await client(runner).initializeDeviceLogin(
      "profile-a",
      "project.feishu.cn",
      new AbortController().signal,
    );

    expect(attempt).toMatchObject({
      profileName: "profile-a",
      intervalMs: 5_000,
      expiresAt: "2026-08-11T00:10:00.000Z",
      userCode: "USER-CODE",
    });
    expect(runner.run.mock.calls[0]![0].args).toEqual([
      "auth", "login", "--device-code",
      "--host", "project.feishu.cn",
      "--phase", "init",
      "--profile", "profile-a",
      "--format", "json",
    ]);
  });

  it("polls a device login once with the captured profile", async () => {
    const runner = new FakeRunner();
    runner.run
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          client_id: "client-example",
          device_code: "device-example",
          expires_in: 600,
          interval: 5,
          user_code: "USER-CODE",
          verification_uri: "https://open.feishu.cn/device",
          verification_uri_complete: "https://open.feishu.cn/device?code=example",
        }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ error: "authorization_pending" }),
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ status: "ok", message: "authorized" }),
        exitCode: 0,
      });
    const meegle = client(runner);
    const signal = new AbortController().signal;
    const attempt = await meegle.initializeDeviceLogin(
      "profile-a", "project.feishu.cn", signal,
    );

    await expect(meegle.pollDeviceLogin("profile-a", attempt, signal))
      .resolves.toEqual({ state: "pending" });
    await expect(meegle.pollDeviceLogin("profile-a", attempt, signal))
      .resolves.toEqual({ state: "authorized" });
    expect(runner.run.mock.calls[1]![0].args).toEqual(expect.arrayContaining([
      "--phase", "poll", "--once", "--profile", "profile-a",
    ]));
  });

  it("accepts the CLI 1.0.19 status-shaped pending response", async () => {
    const runner = new FakeRunner();
    runner.run
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          client_id: "client-example",
          device_code: "device-example",
          expires_in: 600,
          interval: 5,
          user_code: "USER-CODE",
          verification_uri: "https://open.feishu.cn/device",
          verification_uri_complete: "https://open.feishu.cn/device?code=example",
        }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ status: "authorization_pending" }),
        exitCode: 0,
      });
    const meegle = client(runner);
    const signal = new AbortController().signal;
    const attempt = await meegle.initializeDeviceLogin(
      "profile-a", "project.feishu.cn", signal,
    );

    await expect(meegle.pollDeviceLogin("profile-a", attempt, signal))
      .resolves.toEqual({ state: "pending" });
  });

  it("rejects unsafe opaque device values before constructing a poll command", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValueOnce({
      stdout: JSON.stringify({
        client_id: "client-example",
        device_code: 'device"&example',
        expires_in: 600,
        interval: 5,
        user_code: "USER-CODE",
        verification_uri: "https://open.feishu.cn/device",
        verification_uri_complete: "https://open.feishu.cn/device?code=example",
      }),
      exitCode: 0,
    });

    await expect(client(runner).initializeDeviceLogin(
      "default",
      "project.feishu.cn",
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_invalid_response" });
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("maps runner failures to stable content-free errors", async () => {
    const runner = new FakeRunner();
    runner.run.mockRejectedValue(new CommandRunnerError("provider_command_failed", {
      exitCode: 2,
    }));

    const error = await client(runner).getCurrentUser("default")
      .catch((caught) => caught as MeegleCliError);
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).toBe("provider_unavailable");
  });

  it.each([
    [new CommandRunnerError("provider_command_failed", { exitCode: 1, failureKind: "provider_unauthorized" }), "provider_unauthorized"],
    [new CommandRunnerError("provider_command_failed", { exitCode: 1 }), "provider_unavailable"],
    [new CommandRunnerError("provider_command_failed", { exitCode: 2 }), "provider_unavailable"],
    [new CommandRunnerError("provider_timeout"), "provider_timeout"],
    [new Error("runner threw"), "provider_unavailable"],
  ] as const)("maps write runner failures without leaking content", async (failure, code) => {
    const runner = new FakeRunner();
    runner.run.mockRejectedValue(failure);
    const error = await client(runner).createComment("profile", "PROJ", "wi-1", "secret")
      .catch((caught) => caught as MeegleCliError);
    expect(error).toMatchObject({ code, message: code });
    expect(error.message).not.toContain("secret");
  });

  it("maps malformed write JSON to a stable invalid-response error", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({ stdout: "not-json", exitCode: 0 });
    await expect(client(runner).createComment("profile", "PROJ", "wi-1", "content"))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it.each([
    { comment_id: "comment-1", extra: true },
    {},
  ])("rejects unproved comment mutation response shapes", async (response) => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({ stdout: JSON.stringify(response), exitCode: 0 });
    await expect(client(runner).createComment("profile", "PROJ", "wi-1", "content"))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("rejects unknown fields in strict metadata wrappers and entries", async () => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({
      stdout: JSON.stringify({
        pagination: { has_more: false, extra: true },
        list: [{ key: "result", name: "Result", type: "text" }],
      }), exitCode: 0,
    });
    await expect(client(runner).listFieldMetadataPage("profile", "PROJ", "story", 1))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("uses the verified Meegle 1.0.19 write argv contracts", async () => {
    const runner = new FakeRunner();
    runner.run
      .mockResolvedValueOnce({ stdout: JSON.stringify({ pagination: { has_more: false }, list: [] }), exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ comment_id: "comment-1" }), exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ comment_id: "comment-1" }), exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({}), exitCode: 0 });
    const meegle = client(runner);
    const content = "line 1; $(not-shell)\n--profile attacker";

    await meegle.listCommentsPage("profile", "PROJ", "wi-1", 1);
    await meegle.createComment("profile", "PROJ", "wi-1", content);
    await meegle.updateComment("profile", "PROJ", "wi-1", "comment-1", content);
    await meegle.updateWorkItemField("profile", "PROJ", "wi-1", "result", { option_id: "done" });

    expect(runner.run.mock.calls.map(([input]) => input.args)).toEqual([
      ["--profile", "profile", "comment", "list", "--project-key", "PROJ", "--work-item-id", "wi-1", "--page-num", "1", "--format", "json"],
      ["--profile", "profile", "comment", "add", "--project-key", "PROJ", "--work-item-id", "wi-1", "--action", "create", "--content", content, "--format", "json"],
      ["--profile", "profile", "comment", "add", "--project-key", "PROJ", "--work-item-id", "wi-1", "--action", "update", "--comment-id", "comment-1", "--content", content, "--format", "json"],
      ["--profile", "profile", "workitem", "update", "--project-key", "PROJ", "--work-item-id", "wi-1", "--fields", JSON.stringify([{ field_key: "result", field_value: { option_id: "done" } }]), "--format", "json"],
    ]);
  });

  it("propagates type and user key through metadata argv", async () => {
    const runner = new FakeRunner();
    runner.run
      .mockResolvedValueOnce({ stdout: JSON.stringify({ pagination: { has_more: false }, list: [] }), exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ pagination: { has_more: false }, list: [] }), exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ list: [] }), exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ list: [] }), exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ list: [] }), exitCode: 0 });
    const meegle = client(runner);

    await meegle.listFieldMetadataPage("profile", "PROJ", "story", 1);
    await meegle.listRoleMetadataPage("profile", "PROJ", "story", 1);
    await meegle.listStateTransitions("profile", "PROJ", "wi-1", "story", "user-1");
    await meegle.listStateRequired("profile", "PROJ", "wi-1", "done");
    await meegle.getNodeFieldMetadata("profile", "PROJ", "story");

    expect(runner.run.mock.calls.map(([input]) => input.args)).toEqual([
      ["--profile", "profile", "workitem", "meta-fields", "--project-key", "PROJ", "--work-item-type", "story", "--page-num", "1", "--format", "json"],
      ["--profile", "profile", "workitem", "meta-roles", "--project-key", "PROJ", "--work-item-type", "story", "--page-num", "1", "--format", "json"],
      ["--profile", "profile", "workflow", "list-state-transitions", "--project-key", "PROJ", "--work-item-id", "wi-1", "--work-item-type", "story", "--user-key", "user-1", "--format", "json"],
      ["--profile", "profile", "workflow", "list-state-required", "--project-key", "PROJ", "--work-item-id", "wi-1", "--state-key", "done", "--format", "json"],
      ["--profile", "profile", "workflow", "meta-node-fields", "--project-key", "PROJ", "--work-item-type", "story", "--format", "json"],
    ]);
  });

  it.each([
    ["transition", (meegle: MeegleCliClient) => meegle.listStateTransitions("profile", "PROJ", "wi-1", "story", "user-1"), { list: [{ state_key: 3 }] }],
    ["required field", (meegle: MeegleCliClient) => meegle.listStateRequired("profile", "PROJ", "wi-1", "done"), { list: [{ field_key: "required" }] }],
    ["node field", (meegle: MeegleCliClient) => meegle.getNodeFieldMetadata("profile", "PROJ", "story"), { list: [{ field_key: "node" }] }],
    ["role", (meegle: MeegleCliClient) => meegle.listRoleMetadataPage("profile", "PROJ", "story", 1), { pagination: { has_more: false }, list: [{ role_key: "owner" }] }],
  ] as const)("rejects malformed %s metadata entries", async (_name, operation, response) => {
    const runner = new FakeRunner();
    runner.run.mockResolvedValue({ stdout: JSON.stringify(response), exitCode: 0 });
    await expect(operation(client(runner))).rejects.toMatchObject({ code: "provider_invalid_response" });
  });
});
