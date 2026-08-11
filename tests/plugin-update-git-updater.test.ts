import { describe, expect, it } from "vitest";

import {
  PLUGIN_UPDATE_REEXEC_ENV,
  updateGitSource,
} from "../src/plugin-update/git-updater.js";
import type { PluginUpdateResult } from "../src/plugin-update/contracts.js";

describe("updateGitSource", () => {
  it("does not run Git or rebuild by default", async () => {
    const calls: string[] = [];

    const result = await updateGitSource({
      ...baseOptions(calls),
      pull: false,
    });

    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("refuses to pull a dirty worktree", async () => {
    const calls: string[] = [];
    const options = baseOptions(calls);
    options.runCommand = async (_command, args) => ({
      exitCode: 0,
      stdout: args.includes("status") ? " M src/cli.ts\n" : "",
      stderr: "",
    });

    await expect(updateGitSource({ ...options, pull: true }))
      .rejects.toMatchObject({ code: "git_worktree_dirty" });
    expect(calls).toEqual([]);
  });

  it("refuses to pull without an upstream branch", async () => {
    const calls: string[] = [];
    const options = baseOptions(calls);
    options.runCommand = async (_command, args) => {
      if (args.includes("status")) return success("");
      return { exitCode: 1, stdout: "", stderr: "no upstream" };
    };

    await expect(updateGitSource({ ...options, pull: true }))
      .rejects.toMatchObject({ code: "git_upstream_missing" });
  });

  it("uses ff-only then rebuilds and reexecutes exactly once", async () => {
    const calls: string[] = [];
    const options = baseOptions(calls);

    const result = await updateGitSource({ ...options, pull: true });

    expect(result).toEqual(successfulUpdate());
    expect(calls).toEqual([
      "git status --porcelain",
      "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
      "git pull --ff-only",
      "build",
      "reexec:plugin update --pull --json",
    ]);
    expect(options.reexecutedEnvironment?.[PLUGIN_UPDATE_REEXEC_ENV]).toBe("1");
  });

  it("does not pull or reexecute again inside the freshly built updater", async () => {
    const calls: string[] = [];

    const result = await updateGitSource({
      ...baseOptions(calls),
      pull: true,
      environment: { [PLUGIN_UPDATE_REEXEC_ENV]: "1" },
    });

    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("reports a fast-forward pull failure with a stable code", async () => {
    const calls: string[] = [];
    const options = baseOptions(calls);
    options.runCommand = async (_command, args) => args.includes("pull")
      ? { exitCode: 1, stdout: "", stderr: "not fast-forward" }
      : success(args.includes("rev-parse") ? "origin/main\n" : "");

    await expect(updateGitSource({ ...options, pull: true }))
      .rejects.toMatchObject({ code: "git_pull_failed" });
  });

  it("normalizes Git process launch failures", async () => {
    const calls: string[] = [];
    const options = baseOptions(calls);
    options.runCommand = async () => {
      throw new Error("spawn git ENOENT");
    };

    await expect(updateGitSource({ ...options, pull: true }))
      .rejects.toMatchObject({ code: "git_pull_failed" });
  });
});

function baseOptions(calls: string[]) {
  const options: {
    sourceRoot: string;
    environment: Record<string, string | undefined>;
    forwardedArgs: string[];
    runCommand: (command: string, args: string[]) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
    buildUpdater: () => Promise<void>;
    reexecute: (
      environment: Record<string, string | undefined>,
      args: string[],
    ) => Promise<PluginUpdateResult>;
    reexecutedEnvironment?: Record<string, string | undefined>;
  } = {
    sourceRoot: "C:\\source\\FlowRivet",
    environment: { PATH: "fixture" },
    forwardedArgs: ["plugin", "update", "--pull", "--json"],
    runCommand: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return success(args.includes("rev-parse") ? "origin/main\n" : "");
    },
    buildUpdater: async () => {
      calls.push("build");
    },
    reexecute: async (environment, args) => {
      options.reexecutedEnvironment = environment;
      calls.push(`reexec:${args.join(" ")}`);
      return successfulUpdate();
    },
  };
  return options;
}

function success(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

function successfulUpdate(): PluginUpdateResult {
  return {
    ok: true,
    plugin: "flowrivet",
    marketplace: "flowrivet-worktree",
    version: "0.1.0+codex.test",
    companion: {
      pid: 1,
      instanceId: "instance",
      healthUrl: "http://127.0.0.1:43120/health",
    },
    codexRestartRequired: true,
  };
}
