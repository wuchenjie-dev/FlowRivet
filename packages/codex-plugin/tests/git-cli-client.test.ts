import { describe, expect, it, vi } from "vitest";

import { GitCliClient } from "../src/gitlab/git-cli-client.js";

describe("GitCliClient", () => {
  it("inspects a repository with fixed argument arrays", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: "C:/work/flowrivet\n", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "internal\norigin\n", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git\n", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "https://github.com/example/flowrivet.git\n", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "main\n", exitCode: 0 });
    const client = new GitCliClient({ executablePath: "C:\\tools\\git.exe", runner: { run } });

    await expect(client.inspect("C:\\work\\flowrivet")).resolves.toMatchObject({
      root: "C:/work/flowrivet", clean: true, branch: "main",
      originProjectPath: "cc/flowrivet", remoteName: "internal",
    });
    expect(run.mock.calls.map(([input]) => input.args)).toEqual([
      ["rev-parse", "--show-toplevel"], ["remote"],
      ["remote", "get-url", "--all", "internal"], ["remote", "get-url", "--all", "origin"],
      ["status", "--porcelain=v1"], ["branch", "--show-current"],
    ]);
  });

  it("rejects credential-bearing or foreign remote URLs", () => {
    expect(() => GitCliClient.projectPathFromRemote("https://token@gitlab-aiabu.ruijie.com.cn/cc/x.git"))
      .toThrow("git_remote_invalid");
    expect(() => GitCliClient.projectPathFromRemote("https://example.com/cc/x.git"))
      .toThrow("git_remote_invalid");
  });
});
