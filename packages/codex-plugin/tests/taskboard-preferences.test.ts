import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonTaskboardPreferencesStore } from "../src/preferences/json-taskboard-preferences-store.js";
import { TaskboardPreferencesService } from "../src/preferences/taskboard-preferences-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true }),
  ));
});
async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "flowrivet-preferences-"));
  directories.push(path);
  return path;
}

describe("JSON taskboard preferences store", () => {
  it("uses 60 seconds when the preference file does not exist", async () => {
    const service = new TaskboardPreferencesService(
      new JsonTaskboardPreferencesStore({ directory: await temporaryDirectory() }),
    );

    await expect(service.get()).resolves.toEqual({ refreshIntervalSeconds: 60 });
  });

  it.each([0, 5, 3600])("round-trips %s seconds across Store instances", async (seconds) => {
    const directory = await temporaryDirectory();
    const first = new TaskboardPreferencesService(
      new JsonTaskboardPreferencesStore({ directory }),
    );
    const second = new TaskboardPreferencesService(
      new JsonTaskboardPreferencesStore({ directory }),
    );

    await expect(first.save({ refreshIntervalSeconds: seconds })).resolves.toEqual({
      refreshIntervalSeconds: seconds,
    });
    await expect(second.get()).resolves.toEqual({ refreshIntervalSeconds: seconds });

    const contents = await readFile(join(directory, "taskboard-preferences.json"), "utf8");
    expect(JSON.parse(contents)).toEqual({
      version: 1,
      preferences: { refreshIntervalSeconds: seconds },
    });
    expect(contents).not.toMatch(/token|authorization|account/i);
  });

  it.each([
    ["corrupt JSON", "not-json"],
    ["an unknown version", JSON.stringify({
      version: 2,
      preferences: { refreshIntervalSeconds: 60 },
    })],
  ])("returns a stable read error for %s", async (_case, contents) => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "taskboard-preferences.json"), contents, "utf8");
    const service = new TaskboardPreferencesService(
      new JsonTaskboardPreferencesStore({ directory }),
    );

    await expect(service.get()).rejects.toMatchObject({
      code: "taskboard_preferences_read_failed",
    });
  });

  it("returns a stable read error for filesystem failures", async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, "taskboard-preferences.json"));
    const service = new TaskboardPreferencesService(
      new JsonTaskboardPreferencesStore({ directory }),
    );

    await expect(service.get()).rejects.toMatchObject({
      code: "taskboard_preferences_read_failed",
    });
  });

  it("preserves the old file and cleans up when atomic rename fails", async () => {
    const directory = await temporaryDirectory();
    const initial = new TaskboardPreferencesService(
      new JsonTaskboardPreferencesStore({ directory }),
    );
    await initial.save({ refreshIntervalSeconds: 30 });
    const failing = new TaskboardPreferencesService(
      new JsonTaskboardPreferencesStore({
        directory,
        renameFile: vi.fn().mockRejectedValue(new Error("rename failed")),
      }),
    );

    await expect(failing.save({ refreshIntervalSeconds: 10 })).rejects.toMatchObject({
      code: "taskboard_preferences_write_failed",
    });
    await expect(initial.get()).resolves.toEqual({ refreshIntervalSeconds: 30 });
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
