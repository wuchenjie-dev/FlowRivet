import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectRef } from "../src/contracts/projects.js";
import {
  JsonProjectSelectionStore,
  resolveFlowRivetConfigDirectory,
} from "../src/projects/json-project-selection-store.js";

const directories: string[] = [];
const now = "2026-08-07T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true }),
  ));
});

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "flowrivet-projects-"));
  directories.push(path);
  return path;
}

function project(
  externalId: string,
  overrides: Partial<ProjectRef> = {},
): ProjectRef {
  return {
    providerId: "tapd",
    externalId,
    name: `Project ${externalId}`,
    selected: true,
    available: true,
    source: "discovered",
    lastVerifiedAt: now,
    ...overrides,
  };
}

describe("JSON project selection store", () => {
  it("treats a missing file as an empty selection", async () => {
    const store = new JsonProjectSelectionStore({ directory: await temporaryDirectory() });
    await expect(store.load("tapd")).resolves.toEqual([]);
  });

  it("round-trips provider selections without sensitive fields", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonProjectSelectionStore({ directory });
    await store.save("tapd", [project("50396062", { name: "ABF 产品研发" })]);

    await expect(store.load("tapd")).resolves.toEqual([
      expect.objectContaining({ externalId: "50396062", selected: true }),
    ]);
    const contents = await readFile(join(directory, "project-selections.json"), "utf8");
    expect(contents).not.toMatch(/token|authorization/i);
    expect(JSON.parse(contents)).toMatchObject({ version: 1 });
  });

  it("replaces one provider without changing another and clears by provider", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonProjectSelectionStore({ directory });
    await store.save("tapd", [project("A")]);
    await store.save("jira", [project("J", { providerId: "jira" })]);
    await store.save("tapd", [project("B")]);

    await expect(store.load("tapd")).resolves.toMatchObject([{ externalId: "B" }]);
    await expect(store.load("jira")).resolves.toMatchObject([{ externalId: "J" }]);
    await store.clear("tapd");
    await expect(store.load("tapd")).resolves.toEqual([]);
    await expect(store.load("jira")).resolves.toHaveLength(1);
  });

  it("rejects malformed persisted data", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonProjectSelectionStore({ directory });
    await store.save("tapd", [project("A")]);
    await writeFile(join(directory, "project-selections.json"), "not-json", "utf8");

    await expect(store.load("tapd")).rejects.toMatchObject({
      code: "selection_store_failed",
    });
  });

  it("preserves the old file and removes the temporary file when rename fails", async () => {
    const directory = await temporaryDirectory();
    const initial = new JsonProjectSelectionStore({ directory });
    await initial.save("tapd", [project("A")]);
    const store = new JsonProjectSelectionStore({
      directory,
      renameFile: vi.fn().mockRejectedValue(new Error("rename failed")),
    });

    await expect(store.save("tapd", [project("B")])).rejects.toMatchObject({
      code: "selection_store_failed",
    });
    await expect(initial.load("tapd")).resolves.toMatchObject([{ externalId: "A" }]);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("FlowRivet config directory", () => {
  it.each([
    ["win32", { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" }, "C:\\Users\\dev\\AppData\\Local\\FlowRivet"],
    ["darwin", {}, "/Users/dev/Library/Application Support/FlowRivet"],
    ["linux", { XDG_CONFIG_HOME: "/config" }, "/config/flowrivet"],
    ["linux", {}, "/home/dev/.config/flowrivet"],
  ] as const)("resolves %s paths", (platform, environment, expected) => {
    expect(resolveFlowRivetConfigDirectory({
      platform,
      environment,
      homeDirectory: platform === "darwin" ? "/Users/dev" : "/home/dev",
    })).toBe(expected);
  });

  it("rejects Windows without LOCALAPPDATA", () => {
    expect(() => resolveFlowRivetConfigDirectory({
      platform: "win32",
      environment: {},
      homeDirectory: "C:\\Users\\dev",
    })).toThrow("LOCALAPPDATA");
  });
});
