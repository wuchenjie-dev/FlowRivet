import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildRuntimePackage } from "../scripts/release/build-runtime-package.mjs";

describe("runtime package builder", () => {
  it("assembles only the self-contained production layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowrivet-release-"));
    const runtime = join(root, "node-runtime");
    const app = join(root, "app-source");
    const output = join(root, "package");
    await mkdir(join(runtime, "licenses"), { recursive: true });
    await writeFile(join(runtime, "node.exe"), "node");
    await writeFile(join(runtime, "LICENSE"), "node license");
    await mkdir(join(app, "packages", "codex-plugin", "dist"), { recursive: true });
    await mkdir(join(app, "packages", "updater", "dist"), { recursive: true });
    await writeFile(join(app, "packages", "codex-plugin", "dist", "index.js"), "plugin");
    await writeFile(join(app, "packages", "updater", "dist", "index.js"), "updater");
    await writeFile(join(app, "package.json"), "{}");
    await writeFile(join(app, "package-lock.json"), "{}");
    await writeFile(join(app, "secret.log"), "no");

    await buildRuntimePackage({ runtimeDirectory: runtime, appDirectory: app, outputDirectory: output, version: "1.2.3", platform: "win32-x64", protocolVersion: 1 });

    await expect(readFile(join(output, "runtime", "node.exe"), "utf8")).resolves.toBe("node");
    await expect(readFile(join(output, "app", "packages", "codex-plugin", "dist", "index.js"), "utf8")).resolves.toBe("plugin");
    await expect(readFile(join(output, "app", "packages", "updater", "dist", "index.js"), "utf8")).resolves.toBe("updater");
    await expect(readFile(join(output, "release-metadata.json"), "utf8")).resolves.toContain('"version": "1.2.3"');
    await expect(readFile(join(output, "app", "secret.log"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
