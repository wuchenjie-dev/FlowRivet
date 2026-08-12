import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export async function resolveCommand(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const extensions = platform === "win32" ? [".exe", ".cmd", ".ps1", ""] : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

export function runCommand(executablePath, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve) => {
    const invocation = spawnInvocation(executablePath, args);
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        windowsHide: true,
        stdio: "pipe",
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch {
      resolve({ exitCode: -1, stdout: "", stderr: "" });
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ exitCode: -1, stdout: "", stderr: "" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const value = Buffer.from(chunk);
      stdoutBytes += value.byteLength;
      if (stdoutBytes <= maxOutputBytes) stdout.push(value);
      else child.kill();
    });
    child.stderr.on("data", (chunk) => {
      const value = Buffer.from(chunk);
      stderrBytes += value.byteLength;
      if (stderrBytes <= maxOutputBytes) stderr.push(value);
      else child.kill();
    });
    child.once("error", () => finish({ exitCode: -1, stdout: "", stderr: "" }));
    child.once("close", (code) => finish({
      exitCode: stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes ? -1 : code ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function spawnInvocation(executablePath, args) {
  if (process.platform !== "win32" || !/\.(cmd|ps1)$/iu.test(executablePath)) {
    return { command: executablePath, args, windowsVerbatimArguments: false };
  }
  if (executablePath.toLowerCase().endsWith(".ps1")) {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", executablePath, ...args],
      windowsVerbatimArguments: false,
    };
  }
  const commandLine = [executablePath, ...args].map(quoteCmdToken).join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function quoteCmdToken(value) {
  if (/[\0\r\n]/u.test(value)) throw new Error("invalid_command_argument");
  return `"${value.replace(/%/gu, "%%").replace(/!/gu, "^^!").replace(/"/gu, '\\"')}"`;
}

export function isMain(importMetaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  return importMetaUrl === new URL(`file:///${entry.replace(/\\/gu, "/")}`).href;
}

export function printProbeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
