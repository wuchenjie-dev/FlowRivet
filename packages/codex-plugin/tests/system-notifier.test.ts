import { describe, expect, it, vi } from "vitest";

import { NativeSystemNotifier } from "../src/notifications/system-notifier.js";

describe("native system notifier", () => {
  it("sends bounded notification text without invoking a shell", async () => {
    const child = {
      once: vi.fn(function(this: unknown, event: string, callback: () => void) {
        if (event === "spawn") callback();
        return this;
      }),
      removeListener: vi.fn(function(this: unknown) { return this; }),
      unref: vi.fn(),
    };
    const spawn = vi.fn(() => child);
    const notifier = new NativeSystemNotifier({
      platform: "linux",
      spawn,
    });

    await notifier.notify({
      title: "T".repeat(200),
      message: "M".repeat(600),
      externalUrl: "https://project.feishu.cn/space/story/detail/42",
    });

    expect(spawn).toHaveBeenCalledWith("notify-send", [
      "--app-name=FlowRivet",
      "T".repeat(120),
      "M".repeat(400),
    ], expect.objectContaining({ shell: false, windowsHide: true }));
  });

  it("escapes Windows toast XML and passes it as an argv value", async () => {
    const child = {
      once: vi.fn(function(this: unknown, event: string, callback: () => void) {
        if (event === "spawn") callback();
        return this;
      }),
      removeListener: vi.fn(function(this: unknown) { return this; }),
      unref: vi.fn(),
    };
    const spawn = vi.fn(() => child);
    const notifier = new NativeSystemNotifier({ platform: "win32", spawn });

    await notifier.notify({ title: "A&B", message: "<changed>" });

    const [command, args, options] = spawn.mock.calls[0] ?? [];
    expect(command).toBe("powershell.exe");
    expect(args?.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const decodedScript = Buffer.from(args?.[3] ?? "", "base64").toString("utf16le");
    expect(decodedScript).toContain("ToastNotificationManager");
    const encodedXml = decodedScript.match(/FromBase64String\('([^']+)'\)/)?.[1] ?? "";
    expect(Buffer.from(encodedXml, "base64").toString("utf8"))
      .toContain("<text>A&amp;B</text><text>&lt;changed&gt;</text>");
    expect(options).toEqual(expect.objectContaining({ shell: false, detached: true }));
  });

  it("rejects unsafe URLs before invoking the native notifier", async () => {
    const spawn = vi.fn();
    const notifier = new NativeSystemNotifier({ spawn });

    await expect(notifier.notify({
      title: "Task",
      message: "Changed",
      externalUrl: "https://example.invalid/steal",
    })).rejects.toMatchObject({ code: "provider_browser_url_invalid" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
