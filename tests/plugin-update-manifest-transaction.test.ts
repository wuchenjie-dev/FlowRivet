import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getManifestTransactionPaths,
  hashManifest,
  runManifestTransaction,
  writeFileAtomically,
} from "../src/plugin-update/manifest-transaction.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("runManifestTransaction", () => {
  it("installs temporary bytes and restores the exact original bytes", async () => {
    const fixture = await createFixture();
    let installedBytes = "";

    await runManifestTransaction(fixture, async () => {
      installedBytes = await readFile(fixture.manifestPath, "utf8");
    });

    expect(installedBytes).toBe(fixture.temporaryManifest.toString());
    expect(await readFile(fixture.manifestPath)).toEqual(fixture.originalManifest);
    await expect(readFile(getManifestTransactionPaths(
      fixture.sourceRoot,
      fixture.transactionDirectory,
    ).journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the original bytes when the operation fails", async () => {
    const fixture = await createFixture();

    await expect(runManifestTransaction(fixture, async () => {
      throw new Error("install failed");
    })).rejects.toThrow("install failed");

    expect(await readFile(fixture.manifestPath)).toEqual(fixture.originalManifest);
  });

  it("restores the original when journal state persistence fails after apply", async () => {
    const fixture = await createFixture();
    let writes = 0;

    await expect(runManifestTransaction({
      ...fixture,
      writeAtomic: async (path, contents) => {
        writes += 1;
        if (writes === 4) throw new Error("journal persistence failed");
        await writeFileAtomically(path, contents);
      },
    }, async () => undefined)).rejects.toThrow("journal persistence failed");

    expect(await readFile(fixture.manifestPath)).toEqual(fixture.originalManifest);
  });

  it("recovers an interrupted temporary manifest before starting", async () => {
    const fixture = await createFixture();
    const paths = getManifestTransactionPaths(fixture.sourceRoot, fixture.transactionDirectory);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(fixture.manifestPath, fixture.temporaryManifest);
    await writeFile(paths.backupPath, fixture.originalManifest);
    await writeFile(paths.journalPath, JSON.stringify({
      version: 1,
      sourcePath: fixture.sourceRoot,
      manifestPath: fixture.manifestPath,
      backupPath: paths.backupPath,
      originalHash: hashManifest(fixture.originalManifest),
      temporaryHash: hashManifest(fixture.temporaryManifest),
      createdAt: "2026-08-11T00:00:00.000Z",
      state: "applied",
    }));

    await runManifestTransaction(fixture, async () => undefined);

    expect(await readFile(fixture.manifestPath)).toEqual(fixture.originalManifest);
  });

  it("cleans an interrupted journal when the original is already restored", async () => {
    const fixture = await createFixture();
    const paths = getManifestTransactionPaths(fixture.sourceRoot, fixture.transactionDirectory);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.backupPath, fixture.originalManifest);
    await writeFile(paths.journalPath, JSON.stringify({
      version: 1,
      sourcePath: fixture.sourceRoot,
      manifestPath: fixture.manifestPath,
      backupPath: paths.backupPath,
      originalHash: hashManifest(fixture.originalManifest),
      temporaryHash: hashManifest(fixture.temporaryManifest),
      createdAt: "2026-08-11T00:00:00.000Z",
      state: "applied",
    }));

    await runManifestTransaction(fixture, async () => undefined);

    await expect(readFile(paths.journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves evidence and refuses recovery when the manifest conflicts", async () => {
    const fixture = await createFixture();
    const paths = getManifestTransactionPaths(fixture.sourceRoot, fixture.transactionDirectory);
    const conflicting = Buffer.from('{"version":"manual-edit"}\n');
    await mkdir(paths.directory, { recursive: true });
    await writeFile(fixture.manifestPath, conflicting);
    await writeFile(paths.backupPath, fixture.originalManifest);
    await writeFile(paths.journalPath, JSON.stringify({
      version: 1,
      sourcePath: fixture.sourceRoot,
      manifestPath: fixture.manifestPath,
      backupPath: paths.backupPath,
      originalHash: hashManifest(fixture.originalManifest),
      temporaryHash: hashManifest(fixture.temporaryManifest),
      createdAt: "2026-08-11T00:00:00.000Z",
      state: "applied",
    }));

    await expect(runManifestTransaction(fixture, async () => undefined))
      .rejects.toMatchObject({ code: "plugin_manifest_recovery_conflict" });
    expect(await readFile(fixture.manifestPath)).toEqual(conflicting);
    expect(await readFile(paths.journalPath, "utf8")).toContain("temporaryHash");
  });

  it("reports a stable recovery conflict when the journal backup is missing", async () => {
    const fixture = await createFixture();
    const paths = getManifestTransactionPaths(fixture.sourceRoot, fixture.transactionDirectory);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(fixture.manifestPath, fixture.temporaryManifest);
    await writeFile(paths.journalPath, JSON.stringify({
      version: 1,
      sourcePath: fixture.sourceRoot,
      manifestPath: fixture.manifestPath,
      backupPath: paths.backupPath,
      originalHash: hashManifest(fixture.originalManifest),
      temporaryHash: hashManifest(fixture.temporaryManifest),
      createdAt: "2026-08-11T00:00:00.000Z",
      state: "applied",
    }));

    await expect(runManifestTransaction(fixture, async () => undefined))
      .rejects.toMatchObject({ code: "plugin_manifest_recovery_conflict" });
    expect(await readFile(fixture.manifestPath)).toEqual(fixture.temporaryManifest);
  });

  it("rejects a concurrent transaction owned by a live process", async () => {
    const fixture = await createFixture();
    const paths = getManifestTransactionPaths(fixture.sourceRoot, fixture.transactionDirectory);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.lockPath, JSON.stringify({ pid: process.pid }));

    await expect(runManifestTransaction(fixture, async () => undefined))
      .rejects.toMatchObject({ code: "plugin_update_in_progress" });
  });
});

async function createFixture() {
  const sourceRoot = await createTemporaryDirectory();
  const transactionDirectory = await createTemporaryDirectory();
  const manifestPath = join(sourceRoot, ".codex-plugin", "plugin.json");
  const originalManifest = Buffer.from('{"name":"flowrivet","version":"0.1.0"}\n');
  const temporaryManifest = Buffer.from('{\n  "name": "flowrivet",\n  "version": "0.1.0+codex.test"\n}\n');
  await mkdir(join(sourceRoot, ".codex-plugin"), { recursive: true });
  await writeFile(manifestPath, originalManifest);
  return {
    sourceRoot,
    transactionDirectory,
    manifestPath,
    originalManifest,
    temporaryManifest,
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "flowrivet-transaction-"));
  temporaryDirectories.push(path);
  return path;
}
