import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  BoundedCommandRunner,
  CommandRunnerError,
  type SpawnProcess,
} from "../src/process/bounded-command-runner.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 8842;
  readonly kill = vi.fn(() => true);
}

function fakeSpawn(child: FakeChild, onSpawn?: () => void): SpawnProcess {
  return vi.fn(() => {
    queueMicrotask(() => onSpawn?.());
    return child as never;
  });
}

describe("shared bounded command runner", () => {
  it("passes a fixed cwd and an explicit minimal environment", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child, () => {
      child.stdout.end("ok");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    const runner = new BoundedCommandRunner({ spawn });

    await expect(runner.run({
      executablePath: "/usr/bin/git",
      args: ["status", "--porcelain=v1"],
      cwd: "/work/repo",
      environment: { PATH: "/usr/bin", LANG: "C" },
      timeoutMs: 1_000,
    })).resolves.toEqual({ stdout: "ok", exitCode: 0 });

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/git",
      ["status", "--porcelain=v1"],
      expect.objectContaining({
        cwd: "/work/repo",
        env: { PATH: "/usr/bin", LANG: "C" },
        shell: false,
      }),
    );
  });

  it("writes stdin without including it in process arguments", async () => {
    const child = new FakeChild();
    let submitted = "";
    child.stdin.on("data", (chunk) => { submitted += chunk.toString(); });
    const spawn = fakeSpawn(child, () => {
      child.stdout.end("created");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    const runner = new BoundedCommandRunner({ spawn });

    await runner.run({
      executablePath: "/usr/bin/glab",
      args: ["mr", "create"],
      stdin: "sensitive merge request body",
      timeoutMs: 1_000,
    });

    expect(submitted).toBe("sensitive merge request body");
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/glab",
      ["mr", "create"],
      expect.any(Object),
    );
  });

  it("keeps windows hidden by default but allows an explicit GUI process", async () => {
    const hiddenChild = new FakeChild();
    const hiddenSpawn = fakeSpawn(hiddenChild, () => hiddenChild.emit("close", 0, null));
    const hiddenRunner = new BoundedCommandRunner({ spawn: hiddenSpawn, platform: "win32" });
    await hiddenRunner.run({ executablePath: "C:\\tool.exe", args: [], timeoutMs: 1_000 });
    expect(hiddenSpawn).toHaveBeenCalledWith(
      "C:\\tool.exe", [], expect.objectContaining({ windowsHide: true }),
    );

    const visibleChild = new FakeChild();
    const visibleSpawn = fakeSpawn(visibleChild, () => visibleChild.emit("close", 0, null));
    const visibleRunner = new BoundedCommandRunner({ spawn: visibleSpawn, platform: "win32" });
    await visibleRunner.run({
      executablePath: "C:\\gui-tool.exe", args: [], timeoutMs: 1_000, windowsHide: false,
    });
    expect(visibleSpawn).toHaveBeenCalledWith(
      "C:\\gui-tool.exe", [], expect.objectContaining({ windowsHide: false }),
    );
  });

  it("rejects an argument containing a line break before spawning", async () => {
    const spawn = vi.fn();
    const runner = new BoundedCommandRunner({ spawn: spawn as SpawnProcess });

    const error = await runner.run({
      executablePath: "/usr/bin/glab",
      args: ["repo", "list\nmalicious"],
      timeoutMs: 1_000,
    }).catch((caught) => caught as CommandRunnerError);

    expect(error).toMatchObject({ code: "provider_unavailable" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
