import { describe, expect, it, vi } from "vitest";

import { createStartupCommands, StartupManager } from "../src/startup/startup-manager.js";

describe("startup commands", () => {
  it("uses an absolute packaged updater path on Windows", () => {
    expect(createStartupCommands({ platform: "win32", executablePath: "C:\\FlowRivet\\updater.exe" }).install).toEqual({
      command: "schtasks.exe",
      args: ["/Create", "/F", "/SC", "ONLOGON", "/TN", "FlowRivet Updater", "/TR", '"C:\\FlowRivet\\updater.exe" run', "/RL", "LIMITED"],
    });
  });

  it("uses launchctl and systemctl user services without PATH lookup for the updater", () => {
    expect(createStartupCommands({ platform: "darwin", executablePath: "/Applications/FlowRivet/updater" }).install.command).toBe("/bin/launchctl");
    expect(createStartupCommands({ platform: "linux", executablePath: "/opt/flowrivet/updater" }).install).toEqual({
      command: "/usr/bin/systemctl",
      args: ["--user", "enable", "--now", "flowrivet-updater.service"],
    });
  });

  it("writes a Linux user unit before enabling it and supports status/removal", async () => {
    const writes: Array<{ path: string; value: string }> = [];
    const runs: Array<{ command: string; args: string[] }> = [];
    const manager = new StartupManager({
      platform: "linux",
      executablePath: "/opt/flowrivet/updater",
      homeDirectory: "/home/test",
      writeFile: async (path, value) => { writes.push({ path, value }); },
      removeFile: vi.fn(async () => undefined),
      run: async (command, args) => { runs.push({ command, args }); return { exitCode: 0 }; },
    });

    await manager.install();
    await expect(manager.status()).resolves.toBe(true);
    await manager.remove();

    expect(writes[0]?.path).toBe("/home/test/.config/systemd/user/flowrivet-updater.service");
    expect(writes[0]?.value).toContain("ExecStart=/opt/flowrivet/updater run");
    expect(runs.map((run) => run.args[1])).toEqual(["daemon-reload", "enable", "is-active", "disable", "daemon-reload"]);
  });
});
