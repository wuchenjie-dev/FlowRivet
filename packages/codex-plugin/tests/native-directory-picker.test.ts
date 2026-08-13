import { posix, win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DirectoryPickerError,
  type DirectorySelection,
} from "../src/local-directory/directory-picker.js";
import {
  NativeDirectoryPicker,
  type DirectoryPickerCommandRunner,
} from "../src/local-directory/native-directory-picker.js";
import { CommandRunnerError } from "../src/process/bounded-command-runner.js";

function runner(result: { stdout: string; exitCode: number } = {
  stdout: "C:\\workspace\\example\r\n",
  exitCode: 0,
}) {
  return {
    run: vi.fn<DirectoryPickerCommandRunner["run"]>().mockResolvedValue(result),
  };
}

function picker(options: {
  platform?: NodeJS.Platform;
  runner?: DirectoryPickerCommandRunner;
  resolve?: (command: string) => Promise<string>;
} = {}) {
  return new NativeDirectoryPicker({
    platform: options.platform ?? "win32",
    runner: options.runner ?? runner(),
    resolveExecutable: options.resolve ?? (async (command) => command === "powershell"
      ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      : `/usr/bin/${command}`),
  });
}

function select(instance: NativeDirectoryPicker) {
  return instance.selectDirectory({
    purpose: "existing_repository",
    signal: new AbortController().signal,
  });
}

describe("NativeDirectoryPicker", () => {
  it("uses a fixed STA PowerShell script on Windows", async () => {
    const commandRunner = runner();
    const instance = picker({ runner: commandRunner });

    await expect(select(instance)).resolves.toEqual({
      outcome: "selected",
      absolutePath: "C:\\workspace\\example",
    });

    const input = commandRunner.run.mock.calls[0]![0];
    expect(input.executablePath).toMatch(/powershell\.exe$/iu);
    expect(input.args.slice(0, 4)).toEqual([
      "-NoProfile", "-STA", "-NonInteractive", "-EncodedCommand",
    ]);
    expect(input.args[4]).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    const script = Buffer.from(input.args[4]!, "base64").toString("utf16le");
    expect(script).toContain("New-Object -ComObject Shell.Application");
    expect(script).toContain("BrowseForFolder");
    expect(script).not.toContain("System.Windows.Forms");
    expect(input.args.join(" ")).not.toContain("existing_repository");
    expect(input).toMatchObject({ timeoutMs: 600_000, allowExitCodes: [0, 1] });
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses fixed native commands on macOS and Linux", async () => {
    const macRunner = runner({ stdout: "/Users/example/work\n", exitCode: 0 });
    const mac = picker({ platform: "darwin", runner: macRunner });
    await expect(select(mac)).resolves.toMatchObject({ outcome: "selected" });
    expect(macRunner.run.mock.calls[0]![0]).toMatchObject({
      executablePath: "/usr/bin/osascript",
      args: ["-e", expect.stringContaining("choose folder")],
    });

    const linuxRunner = runner({ stdout: "/home/example/work\n", exitCode: 0 });
    const linux = picker({ platform: "linux", runner: linuxRunner });
    await expect(select(linux)).resolves.toMatchObject({ outcome: "selected" });
    expect(linuxRunner.run.mock.calls[0]![0]).toMatchObject({
      executablePath: "/usr/bin/zenity",
      args: ["--file-selection", "--directory"],
    });
  });

  it("falls back from zenity to kdialog and reports missing pickers", async () => {
    const commandRunner = runner({ stdout: "/home/example/work", exitCode: 0 });
    const resolve = vi.fn(async (command: string) => {
      if (command === "zenity") throw new CommandRunnerError("provider_cli_missing");
      if (command === "kdialog") return "/usr/bin/kdialog";
      throw new CommandRunnerError("provider_cli_missing");
    });
    await expect(select(picker({ platform: "linux", runner: commandRunner, resolve })))
      .resolves.toMatchObject({ outcome: "selected" });
    expect(commandRunner.run.mock.calls[0]![0].args).toEqual(["--getexistingdirectory"]);

    await expect(select(picker({
      platform: "linux",
      resolve: async () => { throw new CommandRunnerError("provider_cli_missing"); },
    }))).rejects.toMatchObject({ code: "directory_picker_unavailable" });
  });

  it("maps an explicit exit-one empty result to user cancellation", async () => {
    await expect(select(picker({ runner: runner({ stdout: "", exitCode: 1 }) })))
      .resolves.toEqual<DirectorySelection>({ outcome: "cancelled" });
  });

  it("rejects invalid output without exposing it in the error", async () => {
    for (const output of [
      { stdout: "relative/path", exitCode: 0 },
      { stdout: "", exitCode: 0 },
      { stdout: "C:\\private\\folder", exitCode: 1 },
    ]) {
      const error = await select(picker({ runner: runner(output) }))
        .catch((caught) => caught as DirectoryPickerError);
      expect(error.code).toBe("directory_picker_invalid_result");
      expect(error.message).toBe("directory_picker_invalid_result");
      if (output.stdout) expect(error.message).not.toContain(output.stdout);
    }
  });

  it("uses platform-specific absolute path validation", async () => {
    expect(win32.isAbsolute("C:\\workspace")).toBe(true);
    expect(posix.isAbsolute("/workspace")).toBe(true);
    await expect(select(picker({
      platform: "darwin",
      runner: runner({ stdout: "C:\\workspace", exitCode: 0 }),
    }))).rejects.toMatchObject({ code: "directory_picker_invalid_result" });
  });

  it("maps bounded runner failures to content-free stable errors", async () => {
    const cases = [
      ["provider_timeout", "directory_picker_failed"],
      ["provider_cancelled", "directory_picker_failed"],
      ["provider_output_limit", "directory_picker_failed"],
      ["provider_command_failed", "directory_picker_failed"],
    ] as const;
    for (const [runnerCode, expected] of cases) {
      const commandRunner = runner();
      commandRunner.run.mockRejectedValueOnce(new CommandRunnerError(runnerCode));
      const error = await select(picker({ runner: commandRunner }))
        .catch((caught) => caught as DirectoryPickerError);
      expect(error).toMatchObject({ code: expected, message: expected });
    }
  });

  it("allows only one active selection and releases the lock in finally", async () => {
    let resolveFirst!: (value: { stdout: string; exitCode: number }) => void;
    const pending = new Promise<{ stdout: string; exitCode: number }>((resolve) => {
      resolveFirst = resolve;
    });
    const commandRunner = runner();
    commandRunner.run.mockReturnValueOnce(pending);
    const instance = picker({ runner: commandRunner });

    const first = select(instance);
    await expect(select(instance)).rejects.toMatchObject({ code: "directory_picker_busy" });
    resolveFirst({ stdout: "C:\\workspace\\example", exitCode: 0 });
    await expect(first).resolves.toMatchObject({ outcome: "selected" });
    await expect(select(instance)).resolves.toMatchObject({ outcome: "selected" });
  });
});
