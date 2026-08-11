import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { locateCodexExecutable } from "../src/plugin-update/codex-locator.js";
import { locatePluginSource } from "../src/plugin-update/source-locator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("locatePluginSource", () => {
  it("walks up from a built CLI file to the FlowRivet plugin root", async () => {
    const root = await createPluginFixture();
    const cliFile = join(root, "dist", "src", "cli.js");
    await mkdir(join(root, "dist", "src"), { recursive: true });
    await writeFile(cliFile, "", "utf8");

    const source = await locatePluginSource(cliFile);
    const canonicalRoot = await realpath(root);

    expect(source.root).toBe(canonicalRoot);
    expect(source.manifestPath).toBe(join(canonicalRoot, ".codex-plugin", "plugin.json"));
    expect(source.version).toBe("0.1.0+codex.fixture");
  });

  it("rejects directories that are not a FlowRivet plugin checkout", async () => {
    const root = await createTemporaryDirectory();

    await expect(locatePluginSource(root)).rejects.toMatchObject({
      code: "plugin_source_not_found",
    });
  });
});

describe("locateCodexExecutable", () => {
  it("prefers the bundled Codex executable after validating it", async () => {
    const home = await createTemporaryDirectory();
    const executable = join(home, "plugins", ".plugin-appserver", "codex.exe");
    await mkdir(join(home, "plugins", ".plugin-appserver"), { recursive: true });
    await writeFile(executable, "", "utf8");
    const calls: string[] = [];

    const located = await locateCodexExecutable({
      codexHome: home,
      platform: "win32",
      runCommand: async (command, args) => {
        calls.push([command, ...args].join(" "));
        return { exitCode: 0, stdout: "codex 1.0", stderr: "" };
      },
    });

    expect(located).toBe(executable);
    expect(calls).toEqual([`${executable} --version`]);
  });

  it("falls back to Codex on PATH and reports a stable error when unavailable", async () => {
    const home = await createTemporaryDirectory();

    await expect(locateCodexExecutable({
      codexHome: home,
      platform: "linux",
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "missing" }),
    })).rejects.toMatchObject({ code: "codex_cli_not_found" });
  });
});

async function createPluginFixture(): Promise<string> {
  const root = await createTemporaryDirectory();
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "flowrivet" }), "utf8");
  await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "flowrivet",
    version: "0.1.0+codex.fixture",
  }), "utf8");
  return root;
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "flowrivet-source-"));
  temporaryDirectories.push(path);
  return path;
}
