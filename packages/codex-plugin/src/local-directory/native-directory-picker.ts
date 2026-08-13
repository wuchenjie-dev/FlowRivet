import { posix, win32 } from "node:path";

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
$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, 'Select a folder', 0x51, 0)
if ($null -ne $folder) {
  [Console]::Out.Write($folder.Self.Path)
  exit 0
}
exit 1
`.trim();

const MACOS_SCRIPT = 'POSIX path of (choose folder with prompt "Select a folder")';

export interface DirectoryPickerCommandRunner {
  run(input: CommandRunInput): Promise<CommandRunResult>;
}

export class NativeDirectoryPicker implements DirectoryPicker {
  private active = false;
  private readonly platform: NodeJS.Platform;
  private readonly runner: DirectoryPickerCommandRunner;
  private readonly executableResolver: (command: string) => Promise<string>;

  constructor(options: {
    platform?: NodeJS.Platform;
    runner?: DirectoryPickerCommandRunner;
    resolveExecutable?: (command: string) => Promise<string>;
  } = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? new BoundedCommandRunner({ platform: this.platform });
    this.executableResolver = options.resolveExecutable
      ?? ((command) => resolveExecutable({ command, platform: this.platform }));
  }

  async selectDirectory(input: Parameters<DirectoryPicker["selectDirectory"]>[0]) {
    if (this.active) throw new DirectoryPickerError("directory_picker_busy");
    this.active = true;
    try {
      const command = await this.command();
      const result = await this.runner.run({
        ...command,
        timeoutMs: 600_000,
        allowExitCodes: [0, 1],
        signal: input.signal,
        windowsHide: this.platform === "win32" ? false : undefined,
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

  private async command(): Promise<Pick<CommandRunInput, "executablePath" | "args">> {
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
      };
    }
    if (this.platform === "darwin") {
      return {
        executablePath: await this.executableResolver("osascript"),
        args: ["-e", MACOS_SCRIPT],
      };
    }
    if (this.platform === "linux") {
      try {
        return {
          executablePath: await this.executableResolver("zenity"),
          args: ["--file-selection", "--directory"],
        };
      } catch (error) {
        if (!(error instanceof CommandRunnerError)
          || error.code !== "provider_cli_missing") throw error;
      }
      return {
        executablePath: await this.executableResolver("kdialog"),
        args: ["--getexistingdirectory"],
      };
    }
    throw new DirectoryPickerError("directory_picker_unavailable");
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
