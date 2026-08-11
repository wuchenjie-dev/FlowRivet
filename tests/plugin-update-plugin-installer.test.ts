import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installLocalPlugin } from "../src/plugin-update/plugin-installer.js";
import {
  getManifestTransactionPaths,
  hashManifest,
} from "../src/plugin-update/manifest-transaction.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("installLocalPlugin", () => {
  it("uses the official cachebuster helper and Codex plugin add", async () => {
    const fixture = await createFixture();
    const calls: Array<{ command: string; args: string[] }> = [];

    const result = await installLocalPlugin({
      ...fixture,
      cachebuster: "transaction-test",
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (args.includes("--version")) {
          return { exitCode: 0, stdout: "Python 3", stderr: "" };
        }
        if (args.includes("--cachebuster")) {
          const temporaryRoot = args[1]!;
          const path = join(temporaryRoot, ".codex-plugin", "plugin.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          manifest.version = "0.1.0+codex.transaction-test";
          await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
          return { exitCode: 0, stdout: "updated", stderr: "" };
        }
        if (args.includes("list")) {
          return {
            exitCode: 0,
            stdout: codexPluginList("0.1.0+codex.transaction-test"),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "installed", stderr: "" };
      },
    });

    expect(result.version).toBe("0.1.0+codex.transaction-test");
    expect(calls.some(({ args }) => args[0] === "plugin" && args[1] === "add" &&
      args[2] === "flowrivet@flowrivet-worktree")).toBe(true);
    expect(calls.some(({ args }) => args.some((arg) => arg.endsWith(
      "plugin-creator\\scripts\\update_plugin_cachebuster.py",
    )) || args.some((arg) => arg.endsWith(
      "plugin-creator/scripts/update_plugin_cachebuster.py",
    )))).toBe(true);
    expect(await readFile(fixture.manifestPath)).toEqual(fixture.originalManifest);
  });

  it("restores the manifest when Codex installation fails", async () => {
    const fixture = await createFixture();

    await expect(installLocalPlugin({
      ...fixture,
      cachebuster: "transaction-test",
      runCommand: async (_command, args) => {
        if (args.includes("--version")) {
          return { exitCode: 0, stdout: "Python 3", stderr: "" };
        }
        if (args.includes("--cachebuster")) {
          const path = join(args[1]!, ".codex-plugin", "plugin.json");
          await writeFile(path, '{"name":"flowrivet","version":"0.1.0+codex.test"}\n');
          return { exitCode: 0, stdout: "updated", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "install rejected" };
      },
    })).rejects.toMatchObject({ code: "plugin_install_failed" });

    expect(await readFile(fixture.manifestPath)).toEqual(fixture.originalManifest);
  });

  it("refuses success when Codex still reports the previous plugin version", async () => {
    const fixture = await createFixture();

    await expect(installLocalPlugin({
      ...fixture,
      cachebuster: "expected",
      runCommand: async (_command, args) => {
        if (args.includes("--version")) {
          return { exitCode: 0, stdout: "Python 3", stderr: "" };
        }
        if (args.includes("--cachebuster")) {
          const path = join(args[1]!, ".codex-plugin", "plugin.json");
          await writeFile(path, '{"name":"flowrivet","version":"0.1.0+codex.expected"}\n');
          return { exitCode: 0, stdout: "updated", stderr: "" };
        }
        if (args.includes("list")) {
          return {
            exitCode: 0,
            stdout: codexPluginList("0.1.0+codex.previous"),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "installed", stderr: "" };
      },
    })).rejects.toMatchObject({ code: "plugin_install_failed" });

    expect(await readFile(fixture.manifestPath)).toEqual(fixture.originalManifest);
  });

  it("normalizes Codex process launch failures and restores the manifest", async () => {
    const fixture = await createFixture();

    await expect(installLocalPlugin({
      ...fixture,
      cachebuster: "spawn-failure",
      runCommand: async (_command, args) => {
        if (args.includes("--version")) {
          return { exitCode: 0, stdout: "Python 3", stderr: "" };
        }
        if (args.includes("--cachebuster")) {
          const path = join(args[1]!, ".codex-plugin", "plugin.json");
          await writeFile(path, '{"name":"flowrivet","version":"0.1.0+codex.spawn-failure"}\n');
          return { exitCode: 0, stdout: "updated", stderr: "" };
        }
        throw new Error("spawn codex ENOENT");
      },
    })).rejects.toMatchObject({ code: "plugin_install_failed" });
    expect(await readFile(fixture.manifestPath)).toEqual(fixture.originalManifest);
  });

  it("recovers an interrupted prior transaction before reading the original", async () => {
    const fixture = await createFixture();
    const staleTemporary = Buffer.from(
      '{"name":"flowrivet","version":"0.1.0+codex.stale"}\n',
    );
    const paths = getManifestTransactionPaths(
      fixture.sourceRoot,
      fixture.transactionDirectory,
    );
    await mkdir(paths.directory, { recursive: true });
    await writeFile(fixture.manifestPath, staleTemporary);
    await writeFile(paths.backupPath, fixture.originalManifest);
    await writeFile(paths.journalPath, JSON.stringify({
      version: 1,
      sourcePath: fixture.sourceRoot,
      manifestPath: fixture.manifestPath,
      backupPath: paths.backupPath,
      originalHash: hashManifest(fixture.originalManifest),
      temporaryHash: hashManifest(staleTemporary),
      createdAt: "2026-08-11T00:00:00.000Z",
      state: "applied",
    }));

    await installLocalPlugin({
      ...fixture,
      cachebuster: "recovered",
      runCommand: async (_command, args) => {
        if (args.includes("--version")) {
          return { exitCode: 0, stdout: "Python 3", stderr: "" };
        }
        if (args.includes("--cachebuster")) {
          const path = join(args[1]!, ".codex-plugin", "plugin.json");
          await writeFile(path, '{"name":"flowrivet","version":"0.1.0+codex.recovered"}\n');
        }
        if (args.includes("list")) {
          return {
            exitCode: 0,
            stdout: codexPluginList("0.1.0+codex.recovered"),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });

    expect(await readFile(fixture.manifestPath)).toEqual(fixture.originalManifest);
  });
});

async function createFixture() {
  const sourceRoot = await createTemporaryDirectory();
  const codexHome = await createTemporaryDirectory();
  const transactionDirectory = await createTemporaryDirectory();
  const manifestPath = join(sourceRoot, ".codex-plugin", "plugin.json");
  const helperPath = join(
    codexHome,
    "skills",
    ".system",
    "plugin-creator",
    "scripts",
    "update_plugin_cachebuster.py",
  );
  const originalManifest = Buffer.from('{"name":"flowrivet","version":"0.1.0"}\n');
  await mkdir(join(sourceRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(helperPath, ".."), { recursive: true });
  await writeFile(manifestPath, originalManifest);
  await writeFile(helperPath, "# fixture");
  return {
    sourceRoot,
    manifestPath,
    originalManifest,
    codexHome,
    codexExecutable: "codex",
    pluginId: "flowrivet@flowrivet-worktree",
    transactionDirectory,
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "flowrivet-installer-"));
  temporaryDirectories.push(path);
  return path;
}

function codexPluginList(version: string): string {
  return JSON.stringify({
    installed: [{
      pluginId: "flowrivet@flowrivet-worktree",
      version,
      installed: true,
      enabled: true,
    }],
  });
}
