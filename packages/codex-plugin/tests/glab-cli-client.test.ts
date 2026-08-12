import { describe, expect, it, vi } from "vitest";

import {
  GlabCliClient,
  GitLabAdapterError,
  type GlabCommandRunner,
} from "../src/gitlab/glab-cli-client.js";

function runner(outputs: Array<{ stdout: string; exitCode?: number }>): GlabCommandRunner {
  return {
    run: vi.fn(async () => {
      const next = outputs.shift();
      if (!next) throw new Error("unexpected_command");
      return { stdout: next.stdout, exitCode: next.exitCode ?? 0 };
    }),
  };
}

describe("GlabCliClient", () => {
  it("reports an older glab as unsupported without attempting authentication", async () => {
    const commandRunner = runner([{ stdout: "glab 1.112.9" }]);
    const client = new GlabCliClient({
      executablePath: "C:\\tools\\glab.exe",
      runner: commandRunner,
      host: "gitlab-aiabu.ruijie.com.cn",
    });

    await expect(client.getConnection()).resolves.toEqual({
      host: "gitlab-aiabu.ruijie.com.cn",
      state: "cli_unsupported",
      cliVersion: "1.112.9",
    });
    expect(commandRunner.run).toHaveBeenCalledOnce();
  });

  it("maps version and the authenticated user without returning raw output", async () => {
    const commandRunner = runner([
      { stdout: "glab 1.113.0 (d62881304)" },
      { stdout: JSON.stringify({ username: "wuchenjie", email: "private@example.com" }) },
    ]);
    const client = new GlabCliClient({
      executablePath: "C:\\tools\\glab.exe",
      runner: commandRunner,
      host: "gitlab-aiabu.ruijie.com.cn",
    });

    await expect(client.getConnection()).resolves.toEqual({
      host: "gitlab-aiabu.ruijie.com.cn",
      state: "connected",
      accountDisplayName: "wuchenjie",
      cliVersion: "1.113.0",
    });
    expect(commandRunner.run).toHaveBeenLastCalledWith(expect.objectContaining({
      args: ["api", "user", "--hostname", "gitlab-aiabu.ruijie.com.cn", "--method", "GET"],
    }));
  });

  it("lists member projects with a bounded page and strict public fields", async () => {
    const commandRunner = runner([{ stdout: JSON.stringify([{
      id: 75,
      name: "FlowRivet",
      path_with_namespace: "cc/flowrivet",
      default_branch: "main",
      http_url_to_repo: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git",
    }]) }]);
    const client = new GlabCliClient({
      executablePath: "C:\\tools\\glab.exe",
      runner: commandRunner,
      host: "gitlab-aiabu.ruijie.com.cn",
    });

    await expect(client.listProjects({ page: 2, perPage: 20 })).resolves.toEqual({
      page: 2,
      hasMore: false,
      projects: [{
        host: "gitlab-aiabu.ruijie.com.cn",
        projectId: "75",
        pathWithNamespace: "cc/flowrivet",
        displayName: "FlowRivet",
        defaultBranch: "main",
        httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git",
      }],
    });
    expect(commandRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      args: ["repo", "list", "--member", "--page", "2", "--per-page", "20", "--output", "json"],
    }));
  });

  it("rejects invalid JSON without leaking the response", async () => {
    const client = new GlabCliClient({
      executablePath: "C:\\tools\\glab.exe",
      runner: runner([{ stdout: "access_token=secret" }]),
      host: "gitlab-aiabu.ruijie.com.cn",
    });

    const error = await client.listProjects({ page: 1, perPage: 20 })
      .catch((caught) => caught as GitLabAdapterError);
    expect(error.code).toBe("gitlab_output_invalid");
    expect(error.message).toBe("gitlab_output_invalid");
    expect(error.message).not.toContain("secret");
  });
});
