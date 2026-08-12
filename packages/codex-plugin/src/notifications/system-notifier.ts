import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

import { validateBrowserUrl } from "../providers/system-browser-launcher.js";

export interface SystemNotificationInput {
  title: string;
  message: string;
  externalUrl?: string;
}

export interface SystemNotifier {
  notify(input: SystemNotificationInput): Promise<void>;
}

interface NotificationProcess {
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "spawn", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  unref(): void;
}

type NotificationSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => NotificationProcess;

export class NativeSystemNotifier implements SystemNotifier {
  private readonly platform: NodeJS.Platform;
  private readonly spawn: NotificationSpawn;

  constructor(options: {
    platform?: NodeJS.Platform;
    spawn?: NotificationSpawn;
  } = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? (nodeSpawn as unknown as NotificationSpawn);
  }

  async notify(input: SystemNotificationInput): Promise<void> {
    if (input.externalUrl) {
      validateBrowserUrl(input.externalUrl, ["project.feishu.cn"]);
    }
    const invocation = notificationInvocation(
      this.platform,
      input.title.slice(0, 120),
      input.message.slice(0, 400),
    );
    await spawnDetached(this.spawn, invocation.command, invocation.args);
    // Platform command notifications cannot expose a portable click callback.
    // The durable notification center remains the link-opening surface.
  }
}

function notificationInvocation(
  platform: NodeJS.Platform,
  title: string,
  message: string,
) {
  switch (platform) {
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile", "-NonInteractive", "-Command",
          "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; "
            + "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml($args[0]); "
            + "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml; "
            + "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('FlowRivet').Show($toast)",
          toastXml(title, message),
        ],
      };
    case "darwin":
      return {
        command: "/usr/bin/osascript",
        args: ["-e", "display notification (item 2 of argv) with title (item 1 of argv)", title, message],
      };
    default:
      return { command: "notify-send", args: ["--app-name=FlowRivet", title, message] };
  }
}

function toastXml(title: string, message: string) {
  return `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text>`
    + `<text>${xml(message)}</text></binding></visual></toast>`;
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function spawnDetached(spawn: NotificationSpawn, command: string, args: readonly string[]) {
  return new Promise<void>((resolve, reject) => {
    let child: NotificationProcess;
    try {
      child = spawn(command, args, {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      reject(error);
      return;
    }
    const onSpawn = () => {
      child.removeListener("error", onError);
      child.unref();
      resolve();
    };
    const onError = (error: Error) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}
