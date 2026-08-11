import { describe, expect, it } from "vitest";

import {
  createPluginUpdateService,
  resolveNpmInvocation,
  type PluginUpdateContext,
  type PluginUpdateOrchestratorDependencies,
} from "../src/plugin-update/plugin-update-service.js";
import type { PluginUpdateResult } from "../src/plugin-update/contracts.js";
import { runCommand } from "../src/plugin-update/command-runner.js";

describe("createPluginUpdateService", () => {
  it("runs the safe update stages in the required order", async () => {
    const events: string[] = [];
    const service = createPluginUpdateService(dependencies(events));

    const result = await service({
      pull: false,
      json: false,
      adoptLegacyCompanion: false,
    }, {});

    expect(events).toEqual([
      "preflight",
      "recover",
      "update-source",
      "build",
      "install",
      "stop",
      "start",
    ]);
    expect(result).toEqual(successfulUpdate());
  });

  it("returns the freshly reexecuted updater result without continuing old code", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.updateSource = async () => {
      events.push("update-source");
      return successfulUpdate("0.1.0+codex.fresh");
    };

    const result = await createPluginUpdateService(deps)({
      pull: true,
      json: true,
      adoptLegacyCompanion: true,
    }, {});

    expect(result.version).toBe("0.1.0+codex.fresh");
    expect(events).toEqual(["preflight", "recover", "update-source"]);
  });

  it.each(["build", "install"] as const)(
    "keeps the old Companion running when %s fails",
    async (stage) => {
      const events: string[] = [];
      const deps = dependencies(events);
      deps[stage] = async () => {
        events.push(stage);
        throw new Error(`${stage} failed`);
      };

      await expect(createPluginUpdateService(deps)({
        pull: false,
        json: false,
        adoptLegacyCompanion: false,
      }, {})).rejects.toThrow(`${stage} failed`);
      expect(events).not.toContain("stop");
      expect(events).not.toContain("start");
    },
  );

  it("does not start a replacement when ownership validation prevents stopping", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.stop = async () => {
      events.push("stop");
      throw new Error("ownership rejected");
    };

    await expect(createPluginUpdateService(deps)({
      pull: false,
      json: false,
      adoptLegacyCompanion: false,
    }, {})).rejects.toThrow("ownership rejected");
    expect(events).not.toContain("start");
  });
});

describe("resolveNpmInvocation", () => {
  it.runIf(process.platform === "win32")(
    "executes npm through Node without spawning npm.cmd",
    async () => {
      const invocation = await resolveNpmInvocation({
        platform: "win32",
        environment: {},
        nodeExecutable: process.execPath,
      });

      const result = await runCommand(invocation.command, [
        ...invocation.prefixArgs,
        "--version",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\./u);
    },
  );
});

function dependencies(events: string[]): PluginUpdateOrchestratorDependencies {
  return {
    preflight: async () => {
      events.push("preflight");
      return context();
    },
    recover: async () => {
      events.push("recover");
    },
    updateSource: async () => {
      events.push("update-source");
      return undefined;
    },
    build: async () => {
      events.push("build");
    },
    install: async () => {
      events.push("install");
      return { version: "0.1.0+codex.test" };
    },
    stop: async () => {
      events.push("stop");
    },
    start: async () => {
      events.push("start");
      return successfulUpdate().companion;
    },
  };
}

function context(): PluginUpdateContext {
  return {
    sourceRoot: "C:\\source\\FlowRivet",
    manifestPath: "C:\\source\\FlowRivet\\.codex-plugin\\plugin.json",
    codexHome: "C:\\Users\\test\\.codex",
    codexExecutable: "codex",
    pluginId: "flowrivet@flowrivet-worktree",
    marketplace: "flowrivet-worktree",
    transactionDirectory: "C:\\Users\\test\\AppData\\Local\\FlowRivet",
  };
}

function successfulUpdate(version = "0.1.0+codex.test"): PluginUpdateResult {
  return {
    ok: true,
    plugin: "flowrivet",
    marketplace: "flowrivet-worktree",
    version,
    companion: {
      pid: 4321,
      instanceId: "instance-test",
      healthUrl: "http://127.0.0.1:43120/health",
    },
    codexRestartRequired: true,
  };
}
