import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CompanionProcessManager,
  createSystemProcessAdapter,
  type CompanionProcessAdapter,
  type ProcessInfo,
} from "../src/plugin-update/companion-process-manager.js";
import { resolveCompanionPaths } from "../src/plugin-update/companion-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("resolveCompanionPaths", () => {
  it("resolves the same config location on Windows, Linux, and macOS", () => {
    expect(resolveCompanionPaths({
      sourceRoot: "C:\\source\\FlowRivet",
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      homeDirectory: "C:\\Users\\test",
    }).instancePath).toBe(
      "C:\\Users\\test\\AppData\\Local\\FlowRivet\\companion-instance.json",
    );
    expect(resolveCompanionPaths({
      sourceRoot: "/source/FlowRivet",
      platform: "linux",
      environment: { XDG_CONFIG_HOME: "/config" },
      homeDirectory: "/home/test",
    }).instancePath).toBe("/config/flowrivet/companion-instance.json");
    expect(resolveCompanionPaths({
      sourceRoot: "/source/FlowRivet",
      platform: "darwin",
      environment: {},
      homeDirectory: "/Users/test",
    }).instancePath).toBe(
      "/Users/test/Library/Application Support/FlowRivet/companion-instance.json",
    );
  });
});

describe("CompanionProcessManager", () => {
  it("stops a managed instance only after PID, start time, and health match", async () => {
    const fixture = await managerFixture();
    await fixture.writeManagedInstance();

    await fixture.manager.stopCurrent({ json: true, adoptLegacyCompanion: false });

    expect(fixture.adapter.stopped).toEqual([{ pid: 4321, force: false }]);
  });

  it("rejects PID reuse and mismatched health identity", async () => {
    const reused = await managerFixture({
      processInfo: processInfo({ startedAt: "2026-08-11T00:01:00.000Z" }),
    });
    await reused.writeManagedInstance();
    await expect(reused.manager.stopCurrent({ json: true, adoptLegacyCompanion: false }))
      .rejects.toMatchObject({ code: "companion_ownership_unverified" });
    expect(reused.adapter.stopped).toEqual([]);

    const wrongHealth = await managerFixture({
      health: {
        status: "ok",
        product: "flowrivet-companion",
        pid: 4321,
        instanceId: "somebody-else",
      },
    });
    await wrongHealth.writeManagedInstance();
    await expect(wrongHealth.manager.stopCurrent({ json: true, adoptLegacyCompanion: false }))
      .rejects.toMatchObject({ code: "companion_ownership_unverified" });
    expect(wrongHealth.adapter.stopped).toEqual([]);
  });

  it("removes a stale instance file when its PID no longer exists", async () => {
    const fixture = await managerFixture({ processInfo: undefined });
    await fixture.writeManagedInstance();

    await fixture.manager.stopCurrent({ json: true, adoptLegacyCompanion: false });

    await expect(readFile(fixture.paths.instancePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires explicit legacy adoption in JSON mode", async () => {
    const fixture = await managerFixture({
      managed: false,
      health: { status: "ok" },
      processInfo: processInfo({ arguments: ["dist/server/index.js"] }),
    });
    fixture.adapter.listenerPid = 4321;

    await expect(fixture.manager.stopCurrent({ json: true, adoptLegacyCompanion: false }))
      .rejects.toMatchObject({ code: "companion_legacy_confirmation_required" });

    await fixture.manager.stopCurrent({ json: true, adoptLegacyCompanion: true });
    expect(fixture.adapter.stopped).toEqual([{ pid: 4321, force: false }]);
  });

  it("revalidates a legacy process immediately before stopping it", async () => {
    const fixture = await managerFixture({
      managed: false,
      health: { status: "ok" },
      processInfo: processInfo({ arguments: ["dist/server/index.js"] }),
    });
    fixture.adapter.listenerPid = 4321;
    fixture.adapter.inspectSequence = [
      processInfo({ arguments: ["dist/server/index.js"] }),
      processInfo({
        arguments: ["dist/server/index.js"],
        startedAt: "2026-08-11T00:02:00.000Z",
      }),
    ];

    await expect(fixture.manager.stopCurrent({ json: true, adoptLegacyCompanion: true }))
      .rejects.toMatchObject({ code: "companion_ownership_unverified" });
    expect(fixture.adapter.stopped).toEqual([]);
  });

  it("starts detached and validates the new instance file against health", async () => {
    const fixture = await managerFixture({ managed: false });
    fixture.adapter.onStart = async () => {
      await fixture.writeManagedInstance();
    };

    const instance = await fixture.manager.start();

    expect(instance).toMatchObject({ pid: 4321, instanceId: "managed-instance" });
    expect(fixture.adapter.started).toHaveLength(1);
    expect(fixture.adapter.started[0]?.environment.FLOWRIVET_COMPANION_INSTANCE_FILE)
      .toBe(fixture.paths.instancePath);
  });
});

describe("createSystemProcessAdapter", () => {
  it("parses Windows process identity from PowerShell JSON", async () => {
    const adapter = createSystemProcessAdapter({
      platform: "win32",
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          pid: 42,
          executable: "C:\\Program Files\\nodejs\\node.exe",
          arguments: ["dist/server/index.js"],
          startedAt: "2026-08-11T00:00:00.000Z",
        }),
        stderr: "",
      }),
    });

    await expect(adapter.inspect(42)).resolves.toEqual({
      pid: 42,
      executable: "C:\\Program Files\\nodejs\\node.exe",
      arguments: ["dist/server/index.js"],
      startedAt: "2026-08-11T00:00:00.000Z",
    });
  });

  it.each(["linux", "darwin"] as const)("parses %s process identity from ps", async (platform) => {
    const adapter = createSystemProcessAdapter({
      platform,
      runCommand: async () => ({
        exitCode: 0,
        stdout: "42|2026-08-11T00:00:00.000Z|/usr/bin/node|dist/server/index.js\n",
        stderr: "",
      }),
    });

    await expect(adapter.inspect(42)).resolves.toEqual({
      pid: 42,
      executable: "/usr/bin/node",
      arguments: ["dist/server/index.js"],
      startedAt: "2026-08-11T00:00:00.000Z",
    });
  });
});

async function managerFixture(overrides: {
  managed?: boolean;
  processInfo?: ProcessInfo;
  health?: Record<string, unknown>;
} = {}) {
  const sourceRoot = await createTemporaryDirectory();
  const configDirectory = await createTemporaryDirectory();
  const paths = resolveCompanionPaths({
    sourceRoot,
    platform: "linux",
    environment: { XDG_CONFIG_HOME: configDirectory },
    homeDirectory: sourceRoot,
  });
  const adapter = new FakeAdapter(overrides.processInfo === undefined && "processInfo" in overrides
    ? undefined
    : overrides.processInfo ?? processInfo());
  let health = overrides.health ?? {
    status: "ok",
    product: "flowrivet-companion",
    pid: 4321,
    instanceId: "managed-instance",
  };
  const manager = new CompanionProcessManager({
    paths,
    host: "127.0.0.1",
    port: 43120,
    adapter,
    environment: {},
    fetchHealth: async () => health,
    sleep: async () => undefined,
    healthTimeoutMs: 20,
  });
  const instance = {
    version: 1 as const,
    product: "flowrivet-companion" as const,
    pid: 4321,
    processStartedAt: "2026-08-11T00:00:00.000Z",
    host: "127.0.0.1",
    port: 43120,
    instanceId: "managed-instance",
    startedAt: "2026-08-11T00:00:01.000Z",
  };
  return {
    manager,
    adapter,
    paths,
    setHealth(value: Record<string, unknown>) {
      health = value;
    },
    async writeManagedInstance() {
      await mkdir(join(paths.instancePath, ".."), { recursive: true });
      await writeFile(paths.instancePath, `${JSON.stringify(instance)}\n`);
    },
  };
}

class FakeAdapter implements CompanionProcessAdapter {
  listenerPid: number | undefined;
  stopped: Array<{ pid: number; force: boolean }> = [];
  started: Array<{ environment: Record<string, string | undefined> }> = [];
  inspectSequence: Array<ProcessInfo | undefined> = [];
  onStart?: () => Promise<void>;

  constructor(private info: ProcessInfo | undefined) {}

  async inspect(): Promise<ProcessInfo | undefined> {
    if (this.inspectSequence.length > 0) return this.inspectSequence.shift();
    return this.info;
  }

  async findListener(): Promise<number | undefined> {
    return this.listenerPid;
  }

  async stop(pid: number, force: boolean): Promise<void> {
    this.stopped.push({ pid, force });
    this.info = undefined;
  }

  async start(options: { environment: Record<string, string | undefined> }): Promise<number> {
    this.started.push(options);
    await this.onStart?.();
    return 4321;
  }
}

function processInfo(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: 4321,
    executable: process.platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node",
    arguments: ["packages/codex-plugin/dist/server/index.js"],
    startedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "flowrivet-process-"));
  temporaryDirectories.push(path);
  return path;
}
