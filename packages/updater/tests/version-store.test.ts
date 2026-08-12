import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { VersionStore } from "../src/storage/version-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("version store", () => {
  it("activates an immutable staged version with an atomic pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowrivet-versions-"));
    roots.push(root);
    const store = new VersionStore(root);
    const staging = await store.createStaging("0.2.1");
    await writeFile(join(staging, "release-metadata.json"), "{}", "utf8");

    await store.commitStaging("0.2.1", staging);
    await store.activate("0.2.1", "0.2.0", new Date("2026-08-12T08:00:00Z"));

    await expect(store.readCurrent()).resolves.toEqual({
      schemaVersion: 1,
      activeVersion: "0.2.1",
      previousVersion: "0.2.0",
      activatedAt: "2026-08-12T08:00:00.000Z",
    });
    expect(await readFile(join(root, "current.json"), "utf8")).toContain('"activeVersion": "0.2.1"');
  });

  it("rejects path traversal and an already committed immutable version", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowrivet-versions-"));
    roots.push(root);
    const store = new VersionStore(root);
    await expect(store.createStaging("../escape")).rejects.toThrow("version_invalid");
    const version = join(root, "versions", "0.2.1");
    await mkdir(version, { recursive: true });
    await expect(store.commitStaging("0.2.1", join(root, "staging"))).rejects.toThrow("version_exists");
  });
});
