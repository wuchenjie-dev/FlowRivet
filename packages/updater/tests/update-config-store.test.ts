import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonUpdateConfigStore } from "../src/config/update-config-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("update configuration", () => {
  it("atomically persists only non-secret Registry settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-update-config-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    const store = new JsonUpdateConfigStore(path);
    const config = {
      schemaVersion: 1 as const,
      gitlabBaseUrl: "https://gitlab.internal.example",
      projectId: "42",
      runtimePackageName: "flowrivet-runtime",
      channelPackageName: "flowrivet-channel",
      channelVersion: "latest",
      credentialReference: "FlowRivet/GitLabPackageRegistry/42",
      redirectHostAllowlist: ["objects.internal.example"],
    };

    await store.save(config);

    await expect(store.load()).resolves.toEqual(config);
    const serialized = await readFile(path, "utf8");
    expect(serialized).not.toMatch(/token|password|secret|username/i);
  });

  it("rejects credentials embedded in configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-update-config-"));
    directories.push(directory);
    const store = new JsonUpdateConfigStore(join(directory, "config.json"));
    await expect(store.save({
      schemaVersion: 1,
      gitlabBaseUrl: "https://gitlab.internal.example",
      projectId: "42",
      runtimePackageName: "flowrivet-runtime",
      channelPackageName: "flowrivet-channel",
      channelVersion: "latest",
      credentialReference: "ref",
      redirectHostAllowlist: [],
      token: "secret",
    } as never)).rejects.toThrow();
  });
});
