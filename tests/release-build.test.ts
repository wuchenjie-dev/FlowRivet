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
    await mkdir(join(app, "packages", "runtime-contracts", "dist"), { recursive: true });
    await writeFile(join(app, "packages", "codex-plugin", "dist", "index.js"), "plugin");
    await writeFile(join(app, "packages", "updater", "dist", "index.js"), "updater");
    await writeFile(join(app, "packages", "runtime-contracts", "dist", "index.js"), "contracts");
    await writeFile(join(app, "package.json"), "{}");
    await writeFile(join(app, "package-lock.json"), "{}");
    await writeFile(join(app, "secret.log"), "no");

    await buildRuntimePackage({ runtimeDirectory: runtime, appDirectory: app, outputDirectory: output, version: "1.2.3", platform: "win32-x64", protocolVersion: 1 });

    await expect(readFile(join(output, "runtime", "node.exe"), "utf8")).resolves.toBe("node");
    await expect(readFile(join(output, "app", "packages", "codex-plugin", "dist", "index.js"), "utf8")).resolves.toBe("plugin");
    await expect(readFile(join(output, "app", "packages", "updater", "dist", "index.js"), "utf8")).resolves.toBe("updater");
    await expect(readFile(join(output, "release-metadata.json"), "utf8")).resolves.toContain('"version": "1.2.3"');
    await expect(readFile(join(output, "app", "node_modules", "@flowrivet", "runtime-contracts", "dist", "index.js"), "utf8")).resolves.toBe("contracts");
    await expect(readFile(join(output, "app", "secret.log"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires CI to prune development dependencies before packaging", async () => {
    const pipeline = await readFile(".gitlab-ci.yml", "utf8");
    expect(pipeline).toContain("npm run build");
    expect(pipeline).toContain("npm prune --omit=dev");
    expect(pipeline).toContain("swiftc packages/updater/native/macos-keychain/main.swift");
  });

  it("cleans the package workspace before downloading the runtime", async () => {
    const script = await readFile("scripts/release/ci-package-runtime.mjs", "utf8");
    expect(script.indexOf("await rm(scratch")).toBeGreaterThan(-1);
    expect(script.indexOf("await rm(scratch")).toBeLessThan(script.indexOf("const archive = await resolveRuntimeArchive"));
  });

  it("includes the compiled Keychain helper in a macOS package", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowrivet-macos-release-"));
    const runtime = join(root, "node-runtime");
    const app = join(root, "app-source");
    const output = join(root, "package");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "node"), "node");
    for (const packageName of ["codex-plugin", "updater", "runtime-contracts"]) {
      await mkdir(join(app, "packages", packageName, "dist"), { recursive: true });
      await writeFile(join(app, "packages", packageName, "dist", "index.js"), packageName);
    }
    await mkdir(join(app, "packages", "updater", "native"), { recursive: true });
    await writeFile(join(app, "packages", "updater", "native", "macos-keychain-helper"), "helper");
    await writeFile(join(app, "package.json"), "{}");
    await writeFile(join(app, "package-lock.json"), "{}");

    await buildRuntimePackage({ runtimeDirectory: runtime, appDirectory: app, outputDirectory: output, version: "1.2.3", platform: "darwin-arm64", protocolVersion: 1 });

    await expect(readFile(join(output, "app", "packages", "updater", "native", "macos-keychain-helper"), "utf8")).resolves.toBe("helper");
  });
});
