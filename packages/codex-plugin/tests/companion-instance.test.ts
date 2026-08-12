import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readCompanionInstance,
  removeCompanionInstance,
  resolveCompanionInstancePath,
  writeCompanionInstance,
  type CompanionInstance,
} from "../src/server/companion-instance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("resolveCompanionInstancePath", () => {
  it("uses platform-specific FlowRivet config directories", () => {
    expect(resolveCompanionInstancePath({
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      homeDirectory: "C:\\Users\\test",
    })).toBe(win32.join(
      "C:\\Users\\test\\AppData\\Local",
      "FlowRivet",
      "companion-instance.json",
    ));
    expect(resolveCompanionInstancePath({
      platform: "darwin",
      environment: {},
      homeDirectory: "/Users/test",
    })).toBe(posix.join(
      "/Users/test",
      "Library",
      "Application Support",
      "FlowRivet",
      "companion-instance.json",
    ));
    expect(resolveCompanionInstancePath({
      platform: "linux",
      environment: { XDG_CONFIG_HOME: "/config" },
      homeDirectory: "/home/test",
    })).toBe("/config/flowrivet/companion-instance.json");
  });

  it("honors an explicit updater-owned instance file", () => {
    expect(resolveCompanionInstancePath({
      platform: "linux",
      environment: { FLOWRIVET_COMPANION_INSTANCE_FILE: "/runtime/instance.json" },
      homeDirectory: "/home/test",
    })).toBe("/runtime/instance.json");
  });
});

describe("Companion instance registry", () => {
  it("atomically writes and reads one instance", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "nested", "companion-instance.json");
    const instance = fixtureInstance();

    await writeCompanionInstance(path, instance);

    await expect(readCompanionInstance(path)).resolves.toEqual(instance);
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(instance)}\n`);
  });

  it("removes the file only when it still belongs to the exiting instance", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "companion-instance.json");
    const instance = fixtureInstance();
    await writeCompanionInstance(path, instance);

    await removeCompanionInstance(path, { ...instance, instanceId: "replacement" });
    await expect(readCompanionInstance(path)).resolves.toEqual(instance);

    await removeCompanionInstance(path, instance);
    await expect(readCompanionInstance(path)).resolves.toBeUndefined();
  });
});

function fixtureInstance(): CompanionInstance {
  return {
    version: 1,
    product: "flowrivet-companion",
    pid: 1234,
    runtimeVersion: "0.2.1",
    protocolVersion: 1,
    uiVersion: "0.2.1",
    processStartedAt: "2026-08-11T00:00:00.000Z",
    host: "127.0.0.1",
    port: 43120,
    instanceId: "instance-test",
    startedAt: "2026-08-11T00:00:01.000Z",
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "flowrivet-instance-"));
  temporaryDirectories.push(path);
  return path;
}
