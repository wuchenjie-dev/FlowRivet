import { describe, expect, it, vi } from "vitest";

import { GitLabService } from "../src/gitlab/gitlab-service.js";

describe("GitLabService", () => {
  it("reuses one in-flight browser login and refreshes connection afterwards", async () => {
    let finishLogin!: () => void;
    const login = new Promise<void>((resolve) => { finishLogin = resolve; });
    const adapter = {
      getConnection: vi.fn()
        .mockResolvedValueOnce({ host: "gitlab-aiabu.ruijie.com.cn", state: "disconnected", cliVersion: "1.113.0" })
        .mockResolvedValue({ host: "gitlab-aiabu.ruijie.com.cn", state: "connected", cliVersion: "1.113.0", accountDisplayName: "wuchenjie" }),
      listProjects: vi.fn(),
      getProject: vi.fn(),
    };
    const startLogin = vi.fn(() => login);
    const service = new GitLabService({ adapter, startLogin });

    expect(await service.startLogin()).toMatchObject({ state: "waiting" });
    expect(await service.startLogin()).toMatchObject({ state: "waiting" });
    expect(startLogin).toHaveBeenCalledOnce();

    finishLogin();
    await login;
    await vi.waitFor(() => expect(adapter.getConnection).toHaveBeenCalledTimes(2));
    expect(await service.getConnection()).toMatchObject({ state: "connected" });
  });

  it("does not start login when glab is unavailable", async () => {
    const startLogin = vi.fn();
    const service = new GitLabService({
      adapter: {
        getConnection: vi.fn().mockResolvedValue({ host: "gitlab-aiabu.ruijie.com.cn", state: "cli_missing" }),
        listProjects: vi.fn(),
        getProject: vi.fn(),
      },
      startLogin,
    });

    await expect(service.startLogin()).rejects.toThrow("gitlab_cli_missing");
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("gets a project only after confirming the account is connected", async () => {
    const project = {
      host: "gitlab-aiabu.ruijie.com.cn",
      projectId: "75",
      pathWithNamespace: "cc/flowrivet",
      displayName: "FlowRivet",
      defaultBranch: "main",
      httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git",
    } as const;
    const adapter = {
      getConnection: vi.fn().mockResolvedValue({
        host: "gitlab-aiabu.ruijie.com.cn", state: "connected",
      }),
      listProjects: vi.fn(),
      getProject: vi.fn().mockResolvedValue(project),
    };
    const service = new GitLabService({ adapter, startLogin: vi.fn() });

    await expect(service.getProject("75")).resolves.toEqual(project);
    expect(adapter.getConnection).toHaveBeenCalledOnce();
    expect(adapter.getProject).toHaveBeenCalledWith("75");
  });
});
