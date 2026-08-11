import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  SystemBrowserLauncher,
  SystemBrowserLauncherError,
  type BrowserProcess,
  type BrowserSpawn,
} from "../src/providers/system-browser-launcher.js";

class FakeProcess extends EventEmitter implements BrowserProcess {
  readonly unref = vi.fn();
}

function successfulSpawn() {
  const process = new FakeProcess();
  const spawn = vi.fn<BrowserSpawn>(() => {
    queueMicrotask(() => process.emit("spawn"));
    return process;
  });
  return { process, spawn };
}

describe("system browser launcher", () => {
  it.each([
    ["win32", "explorer.exe", ["https://open.feishu.cn/device?code=example"]],
    ["darwin", "/usr/bin/open", ["https://open.feishu.cn/device?code=example"]],
    ["linux", "xdg-open", ["https://open.feishu.cn/device?code=example"]],
  ] as const)("uses a fixed %s executable without a shell", async (
    platform,
    executable,
    args,
  ) => {
    const { process, spawn } = successfulSpawn();
    const launcher = new SystemBrowserLauncher({ platform, spawn });

    await expect(launcher.open(
      "https://open.feishu.cn/device?code=example",
      ["project.feishu.cn", "open.feishu.cn"],
    )).resolves.toBe("opened");

    expect(spawn).toHaveBeenCalledWith(executable, [...args], {
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    expect(process.unref).toHaveBeenCalledOnce();
  });

  it.each([
    "http://open.feishu.cn/device",
    "https://user:password@open.feishu.cn/device",
    "https://open.feishu.cn.evil.example/device",
    "https://sub.open.feishu.cn/device",
    "https://open.feishu.cn:8443/device",
    "https://example.com/device",
  ])("rejects an unsafe browser URL: %s", async (url) => {
    const spawn = vi.fn<BrowserSpawn>();
    const launcher = new SystemBrowserLauncher({ platform: "win32", spawn });

    await expect(launcher.open(url, ["open.feishu.cn"]))
      .rejects.toBeInstanceOf(SystemBrowserLauncherError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns manual_required when the browser process cannot start", async () => {
    const process = new FakeProcess();
    const spawn = vi.fn<BrowserSpawn>(() => {
      queueMicrotask(() => process.emit("error", new Error("not available")));
      return process;
    });
    const launcher = new SystemBrowserLauncher({ platform: "linux", spawn });

    await expect(launcher.open(
      "https://open.feishu.cn/device",
      ["open.feishu.cn"],
    )).resolves.toBe("manual_required");
  });
});
