import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonActiveProviderStore } from "../src/providers/json-active-provider-store.js";

const directories: string[] = [];
const registeredProviderIds = ["feishu-project", "tapd"];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true }),
  ));
});

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "flowrivet-active-provider-"));
  directories.push(path);
  return path;
}

describe("JSON active provider store", () => {
  it("defaults new users to Feishu Project and persists the decision", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonActiveProviderStore({ directory });

    await expect(store.load({ registeredProviderIds })).resolves.toEqual({
      version: 1,
      activeProviderId: "feishu-project",
    });
    expect(JSON.parse(await readFile(join(directory, "active-provider.json"), "utf8")))
      .toEqual({ version: 1, activeProviderId: "feishu-project" });
  });

  it("round-trips an explicit registered provider choice", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonActiveProviderStore({ directory });

    await store.save({ version: 1, activeProviderId: "tapd" });

    await expect(store.load({ registeredProviderIds })).resolves.toEqual({
      version: 1,
      activeProviderId: "tapd",
    });
    expect(await readFile(join(directory, "active-provider.json"), "utf8"))
      .not.toMatch(/token|authorization|credential/i);
  });

  it("returns a warning and Feishu fallback without overwriting an unknown saved provider", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "active-provider.json");
    const contents = '{"version":1,"activeProviderId":"removed-provider"}\n';
    await writeFile(path, contents, "utf8");
    const store = new JsonActiveProviderStore({ directory });

    await expect(store.load({ registeredProviderIds })).resolves.toEqual({
      version: 1,
      activeProviderId: "feishu-project",
      warningCode: "active_provider_unavailable",
    });
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("does not overwrite malformed data", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "active-provider.json");
    await writeFile(path, "not-json", "utf8");
    const store = new JsonActiveProviderStore({ directory });

    await expect(store.load({ registeredProviderIds })).rejects.toMatchObject({
      code: "active_provider_read_failed",
    });
    expect(await readFile(path, "utf8")).toBe("not-json");
  });

  it("preserves the previous choice and cleans up when atomic rename fails", async () => {
    const directory = await temporaryDirectory();
    const initial = new JsonActiveProviderStore({ directory });
    await initial.save({ version: 1, activeProviderId: "feishu-project" });
    const failing = new JsonActiveProviderStore({
      directory,
      renameFile: vi.fn().mockRejectedValue(new Error("rename failed")),
    });

    await expect(failing.save({ version: 1, activeProviderId: "tapd" }))
      .rejects.toMatchObject({ code: "active_provider_write_failed" });
    await expect(initial.load({ registeredProviderIds })).resolves.toEqual({
      version: 1,
      activeProviderId: "feishu-project",
    });
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);
  });
});
