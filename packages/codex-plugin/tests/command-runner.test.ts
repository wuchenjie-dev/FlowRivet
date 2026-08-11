import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  BoundedCommandRunner,
  CommandRunnerError,
  createSpawnInvocation,
  resolveExecutable,
  type SpawnProcess,
} from "../src/meegle/command-runner.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4567;
  readonly kill = vi.fn(() => true);
}

function fakeSpawn(child: FakeChild, onSpawn?: () => void): SpawnProcess {
  return vi.fn(() => {
    queueMicrotask(() => onSpawn?.());
    return child as never;
  });
}

describe("bounded command runner", () => {
  it("resolves a Windows executable before an npm cmd shim", async () => {
    const found = new Set([
      "C:\\tools\\meegle.exe",
      "C:\\tools\\meegle.cmd",
    ]);

    await expect(resolveExecutable({
      command: "meegle",
      platform: "win32",
      pathValue: "C:\\tools;D:\\bin",
      fileExists: async (candidate) => found.has(candidate),
    })).resolves.toBe("C:\\tools\\meegle.exe");
  });

  it("uses shell false for native executables and a fixed cmd invocation for cmd shims", () => {
    expect(createSpawnInvocation("C:\\tools\\meegle.exe", ["auth", "status"], "win32"))
      .toEqual({
        command: "C:\\tools\\meegle.exe",
        args: ["auth", "status"],
        shell: false,
      });
    expect(createSpawnInvocation("C:\\tools\\meegle.cmd", ["auth", "status"], "win32"))
      .toEqual({
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", '""C:\\tools\\meegle.cmd" "auth" "status""'],
        shell: false,
      });
  });

  it("captures bounded stdout while keeping a fixed argument array", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child, () => {
      child.stdout.end('{"ok":true}');
      child.stderr.end();
      child.emit("close", 0, null);
    });
    const runner = new BoundedCommandRunner({ spawn });

    await expect(runner.run({
      executablePath: "/opt/meegle",
      args: ["auth", "status", "--format", "json"],
      timeoutMs: 1_000,
    })).resolves.toEqual({ stdout: '{"ok":true}', exitCode: 0 });
    expect(spawn).toHaveBeenCalledWith(
      "/opt/meegle",
      ["auth", "status", "--format", "json"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("passes cmd shim quoting through without Node CRT re-escaping", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child, () => {
      child.stdout.end("1.0.19\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    const runner = new BoundedCommandRunner({ spawn, platform: "win32" });

    await runner.run({
      executablePath: "C:\\Program Files\\nodejs\\meegle.cmd",
      args: ["--version"],
      timeoutMs: 1_000,
    });

    expect(spawn).toHaveBeenCalledWith(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\meegle.cmd" "--version""'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
  });

  it.each([
    ["stdout", "provider_output_limit"],
    ["stderr", "provider_output_limit"],
  ] as const)("terminates the process tree when %s exceeds its bound", async (stream, code) => {
    const child = new FakeChild();
    const killProcessTree = vi.fn(async () => undefined);
    const runner = new BoundedCommandRunner({
      spawn: fakeSpawn(child, () => child[stream].write("12345")),
      maxOutputBytes: 4,
      killProcessTree,
    });

    await expect(runner.run({
      executablePath: "/opt/meegle",
      args: ["secret-device-code"],
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code });
    expect(killProcessTree).toHaveBeenCalledWith(child);
  });

  it("terminates on timeout without exposing command output", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const killProcessTree = vi.fn(async () => undefined);
    const runner = new BoundedCommandRunner({ spawn: fakeSpawn(child), killProcessTree });
    const operation = runner.run({
      executablePath: "/opt/meegle",
      args: ["sensitive-argument"],
      timeoutMs: 10,
    }).catch((caught) => caught as CommandRunnerError);
    await vi.advanceTimersByTimeAsync(11);

    const error = await operation;
    expect(error.code).toBe("provider_timeout");
    expect(error.message).toBe("provider_timeout");
    expect(error.message).not.toContain("sensitive-argument");
    expect(killProcessTree).toHaveBeenCalledWith(child);
    vi.useRealTimers();
  });

  it("terminates on abort", async () => {
    const child = new FakeChild();
    const killProcessTree = vi.fn(async () => undefined);
    const runner = new BoundedCommandRunner({ spawn: fakeSpawn(child), killProcessTree });
    const controller = new AbortController();
    const operation = runner.run({
      executablePath: "/opt/meegle",
      args: [],
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(operation).rejects.toMatchObject({ code: "provider_cancelled" });
    expect(killProcessTree).toHaveBeenCalledWith(child);
  });

  it("classifies missing executables and nonzero exits without stderr leakage", async () => {
    const missing = new FakeChild();
    const missingRunner = new BoundedCommandRunner({ spawn: fakeSpawn(missing, () => {
      const error = Object.assign(new Error("spawn secret"), { code: "ENOENT" });
      missing.emit("error", error);
    }) });
    await expect(missingRunner.run({
      executablePath: "/missing/meegle",
      args: [],
      timeoutMs: 1_000,
    })).rejects.toEqual(expect.objectContaining({
      code: "provider_cli_missing",
      message: "provider_cli_missing",
    }));

    const failed = new FakeChild();
    const failedRunner = new BoundedCommandRunner({ spawn: fakeSpawn(failed, () => {
      failed.stdout.end("sensitive stdout");
      failed.stderr.end("sensitive stderr");
      failed.emit("close", 7, null);
    }) });
    const error = await failedRunner.run({
      executablePath: "/opt/meegle",
      args: [],
      timeoutMs: 1_000,
    }).catch((caught) => caught as CommandRunnerError);
    expect(error).toMatchObject({ code: "provider_command_failed", exitCode: 7 });
    expect(error.message).toBe("provider_command_failed");
  });
});
