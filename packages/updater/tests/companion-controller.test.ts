import { join, win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CompanionController, type CompanionProcessAdapter } from "../src/companion/companion-controller.js";

describe("CompanionController", () => {
  it("starts the packaged runtime instead of the updater Node process", async () => {
    const adapter = fixtureAdapter();
    const controller = new CompanionController({
      platform: "win32",
      versionsRoot: "C:\\FlowRivet\\versions",
      instancePath: "C:\\FlowRivet\\data\\companion-instance.json",
      logPath: "C:\\FlowRivet\\logs\\companion.log",
      sharedDataRoot: "C:\\FlowRivet\\data",
      host: "127.0.0.1",
      port: 43119,
      adapter,
      readInstance: async () => fixtureInstance(42, "0.2.0"),
      fetchHealth: async () => ({ status: "ok", ...fixtureInstance(42, "0.2.0") }),
      sleep: async () => undefined,
    });

    await controller.startVersion("0.2.0");

    expect(adapter.start).toHaveBeenCalledWith(expect.objectContaining({
      command: win32.join("C:\\FlowRivet\\versions", "0.2.0", "runtime", "node.exe"),
      arguments: [win32.join("C:\\FlowRivet\\versions", "0.2.0", "app", "packages", "codex-plugin", "dist", "server", "index.js")],
      environment: expect.objectContaining({
        FLOWRIVET_DATA_ROOT: "C:\\FlowRivet\\data",
        FLOWRIVET_RUNTIME_VERSION: "0.2.0",
        FLOWRIVET_UI_VERSION: "0.2.0",
      }),
    }));
  });

  it("refuses to stop a process when health ownership does not match", async () => {
    const adapter = fixtureAdapter();
    const instance = fixtureInstance(42, "0.1.0");
    const controller = new CompanionController({
      platform: "linux",
      versionsRoot: "/flowrivet/versions",
      instancePath: "/flowrivet/data/instance.json",
      logPath: "/flowrivet/logs/companion.log",
      sharedDataRoot: "/flowrivet/data",
      host: "127.0.0.1",
      port: 43119,
      adapter,
      readInstance: async () => instance,
      fetchHealth: async () => ({ status: "ok", ...instance, instanceId: "other" }),
      sleep: async () => undefined,
    });

    await expect(controller.stopCurrent()).rejects.toThrow("companion_ownership_unverified");
    expect(adapter.stop).not.toHaveBeenCalled();
  });
});

function fixtureAdapter(): CompanionProcessAdapter & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => 42),
    stop: vi.fn(async () => undefined),
    inspect: vi.fn(async (pid: number) => ({ pid, startedAt: "2026-08-12T00:00:00.000Z" })),
  };
}

function fixtureInstance(pid: number, runtimeVersion: string) {
  return {
    version: 1 as const,
    product: "flowrivet-companion" as const,
    pid,
    runtimeVersion,
    protocolVersion: 1,
    uiVersion: runtimeVersion,
    processStartedAt: "2026-08-12T00:00:00.000Z",
    host: "127.0.0.1",
    port: 43119,
    instanceId: "instance-1",
    startedAt: "2026-08-12T00:00:01.000Z",
  };
}
