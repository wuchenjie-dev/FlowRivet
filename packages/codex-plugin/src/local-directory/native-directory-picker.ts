import { posix, win32 } from "node:path";
import { stat } from "node:fs/promises";

import {
  BoundedCommandRunner,
  CommandRunnerError,
  resolveExecutable,
  type CommandRunInput,
  type CommandRunResult,
} from "../process/bounded-command-runner.js";
import {
  DirectoryPickerError,
  type DirectoryPicker,
  type DirectorySelection,
} from "./directory-picker.js";

const WINDOWS_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class FlowRivetNativeWindow : IWin32Window {
  public IntPtr Handle { get; private set; }
  public FlowRivetNativeWindow(IntPtr handle) { Handle = handle; }
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@
$initialDirectory = [Console]::In.ReadToEnd()
$owner = [FlowRivetNativeWindow]::new([FlowRivetNativeWindow]::GetForegroundWindow())
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a folder'
$dialog.ShowNewFolderButton = $true
if (-not [string]::IsNullOrWhiteSpace($initialDirectory)) {
  $dialog.SelectedPath = $initialDirectory
}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
  exit 0
}
exit 1
`.trim();

const MACOS_SCRIPT = String.raw`
on run argv
  if (count of argv) > 0 then
    return POSIX path of (choose folder with prompt "Select a folder" default location (POSIX file (item 1 of argv)))
  end if
  return POSIX path of (choose folder with prompt "Select a folder")
end run
`.trim();

export interface DirectoryPickerCommandRunner {
  run(input: CommandRunInput): Promise<CommandRunResult>;
}

export class NativeDirectoryPicker implements DirectoryPicker {
  private active = false;
  private readonly platform: NodeJS.Platform;
  private readonly runner: DirectoryPickerCommandRunner;
  private readonly executableResolver: (command: string) => Promise<string>;
  private readonly directoryExists: (path: string) => Promise<boolean>;

  constructor(options: {
    platform?: NodeJS.Platform;
    runner?: DirectoryPickerCommandRunner;
    resolveExecutable?: (command: string) => Promise<string>;
    directoryExists?: (path: string) => Promise<boolean>;
  } = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? new BoundedCommandRunner({ platform: this.platform });
    this.executableResolver = options.resolveExecutable
      ?? ((command) => resolveExecutable({ command, platform: this.platform }));
    this.directoryExists = options.directoryExists ?? defaultDirectoryExists;
  }

  async selectDirectory(input: Parameters<DirectoryPicker["selectDirectory"]>[0]) {
    if (this.active) throw new DirectoryPickerError("directory_picker_busy");
    this.active = true;
    try {
      const initialDirectory = await this.resolveInitialDirectory(input.initialDirectory);
      const command = await this.command(initialDirectory);
      const result = await this.runner.run({
        ...command,
        timeoutMs: 600_000,
        allowExitCodes: [0, 1],
        signal: input.signal,
        windowsHide: this.platform === "win32" ? true : undefined,
      });
      return this.parseResult(result);
    } catch (error) {
      if (error instanceof DirectoryPickerError) throw error;
      if (error instanceof CommandRunnerError
        && error.code === "provider_cli_missing") {
        throw new DirectoryPickerError("directory_picker_unavailable");
      }
      throw new DirectoryPickerError("directory_picker_failed");
    } finally {
      this.active = false;
    }
  }

  private async command(initialDirectory?: string): Promise<Pick<
    CommandRunInput,
    "executablePath" | "args" | "stdin"
  >> {
    if (this.platform === "win32") {
      return {
        executablePath: await this.executableResolver("powershell"),
        args: [
          "-NoProfile",
          "-STA",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64"),
        ],
        ...(initialDirectory ? { stdin: initialDirectory } : {}),
      };
    }
    if (this.platform === "darwin") {
      return {
        executablePath: await this.executableResolver("osascript"),
        args: ["-e", MACOS_SCRIPT, ...(initialDirectory ? [initialDirectory] : [])],
      };
    }
    if (this.platform === "linux") {
      try {
        return {
          executablePath: await this.executableResolver("zenity"),
          args: [
            "--file-selection",
            "--directory",
            ...(initialDirectory
              ? [`--filename=${ensureTrailingSeparator(initialDirectory, posix.sep)}`]
              : []),
          ],
        };
      } catch (error) {
        if (!(error instanceof CommandRunnerError)
          || error.code !== "provider_cli_missing") throw error;
      }
      return {
        executablePath: await this.executableResolver("kdialog"),
        args: ["--getexistingdirectory", ...(initialDirectory ? [initialDirectory] : [])],
      };
    }
    throw new DirectoryPickerError("directory_picker_unavailable");
  }

  private async resolveInitialDirectory(value: string | undefined) {
    if (!value) return undefined;
    const path = this.platform === "win32" ? win32 : posix;
    if (!path.isAbsolute(value)) return undefined;
    try {
      return await this.directoryExists(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private parseResult(result: CommandRunResult): DirectorySelection {
    const output = result.stdout.trim();
    if (result.exitCode === 1 && output === "") return { outcome: "cancelled" };
    if (result.exitCode !== 0 || output === "") {
      throw new DirectoryPickerError("directory_picker_invalid_result");
    }
    const path = this.platform === "win32" ? win32 : posix;
    if (!path.isAbsolute(output)) {
      throw new DirectoryPickerError("directory_picker_invalid_result");
    }
    return { outcome: "selected", absolutePath: output };
  }
}

async function defaultDirectoryExists(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function ensureTrailingSeparator(path: string, separator: string) {
  return path.endsWith(separator) ? path : `${path}${separator}`;
}
