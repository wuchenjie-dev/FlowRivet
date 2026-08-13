import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

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
        if (platform === "win32" && command === "meegle" && /\.(cmd|ps1)$/iu.test(candidate)) {
          const cliEntry = await resolvePackageBin(directory, "@lark-project/meegle", command);
          if (cliEntry) return cliEntry;
        }
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
  if (/\.(?:c|m)?js$/iu.test(executablePath)) {
    return { command: process.execPath, args: [executablePath, ...args], windowsVerbatimArguments: false };
  }
  if (/\.(cmd|ps1)$/iu.test(executablePath)) return { command: "", args: [], windowsVerbatimArguments: false };
  return { command: executablePath, args, windowsVerbatimArguments: false };
}

async function resolvePackageBin(directory, packageName, command) {
  try {
    const packageDirectory = join(directory, "node_modules", ...packageName.split("/"));
    const packageJson = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    const relativeBin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[command];
    if (typeof relativeBin !== "string") return undefined;
    const cliEntry = resolve(packageDirectory, relativeBin);
    await access(cliEntry);
    return cliEntry;
  } catch {
    return undefined;
  }
}

export function isMain(importMetaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  return importMetaUrl === new URL(`file:///${entry.replace(/\\/gu, "/")}`).href;
}

export function printProbeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
