import { describe, expect, it, vi } from "vitest";

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
});
