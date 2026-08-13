import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCommand, runCommand } from "../scripts/probe-runtime.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("probe runtime", () => {
  it("passes hostile values to a JavaScript CLI as exact argv without shell side effects", async () => {
    const directory = await makeTemporaryDirectory();
    const cli = join(directory, "argv-echo.mjs");
    const sideEffect = join(directory, "injected.txt");
    await writeFile(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n", "utf8");
    const values = [
      'double"quote', "amp&ersand", "pipe|value", "less<value", `greater>${sideEffect}`,
      "percent%value", "bang!value", "with spaces", "Unicode-测试",
    ];

    const result = await runCommand(cli, values);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(result.stdout)).toEqual(values);
    await expect(stat(sideEffect)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a Windows npm shim through the package bin mapping", async () => {
    const directory = await makeTemporaryDirectory();
    const packageDirectory = join(directory, "node_modules", "@lark-project", "meegle");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(packageDirectory, "bin"), { recursive: true }));
    await writeFile(join(directory, "meegle.cmd"), "@echo unsafe shim", "utf8");
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@lark-project/meegle", bin: { meegle: "bin/meegle.js" },
    }), "utf8");
    await writeFile(join(packageDirectory, "bin", "meegle.js"), "", "utf8");

    await expect(resolveCommand("meegle", { platform: "win32", pathValue: directory }))
      .resolves.toBe(join(packageDirectory, "bin", "meegle.js"));
  });

  it("fails closed instead of passing cmd shims through a command shell", async () => {
    const directory = await makeTemporaryDirectory();
    const shim = join(directory, "unsafe.cmd");
    const sideEffect = join(directory, "injected.txt");
    await writeFile(shim, `@echo unsafe > "${sideEffect}"`, "utf8");

    await expect(runCommand(shim, ["&", sideEffect])).resolves.toMatchObject({ exitCode: -1 });
    await expect(stat(sideEffect)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "flowrivet-probe-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}
