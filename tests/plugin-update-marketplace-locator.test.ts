import { describe, expect, it } from "vitest";

import { selectInstalledLocalPlugin } from "../src/plugin-update/marketplace-locator.js";

describe("selectInstalledLocalPlugin", () => {
  it("selects the unique installed and enabled local plugin resolving to the source", async () => {
    const result = await selectInstalledLocalPlugin({
      codexPluginList: pluginList([
        plugin("flowrivet@flowrivet-worktree", "C:\\market\\flowrivet"),
        plugin("flowrivet@disabled", "C:\\other", { enabled: false }),
      ]),
      sourceRoot: "C:\\source\\FlowRivet",
      platform: "win32",
      realpath: async (path) => path === "C:\\market\\flowrivet"
        ? "C:\\SOURCE\\FLOWRIVET"
        : path,
    });

    expect(result).toMatchObject({
      pluginId: "flowrivet@flowrivet-worktree",
      marketplace: "flowrivet-worktree",
      version: "0.1.0",
    });
  });

  it("rejects zero matching local plugins", async () => {
    await expect(selectInstalledLocalPlugin({
      codexPluginList: pluginList([
        plugin("flowrivet@remote", "/source/FlowRivet", {
          marketplaceSource: { sourceType: "git", source: "https://example.test/repo.git" },
        }),
      ]),
      sourceRoot: "/source/FlowRivet",
      platform: "linux",
      realpath: async (path) => path,
    })).rejects.toMatchObject({ code: "plugin_marketplace_mismatch" });
  });

  it("rejects multiple matching local plugins instead of choosing one", async () => {
    await expect(selectInstalledLocalPlugin({
      codexPluginList: pluginList([
        plugin("flowrivet@one", "/links/one"),
        plugin("flowrivet@two", "/links/two"),
      ]),
      sourceRoot: "/source/FlowRivet",
      platform: "linux",
      realpath: async (path) => path.startsWith("/links/") ? "/source/FlowRivet" : path,
    })).rejects.toMatchObject({ code: "plugin_marketplace_ambiguous" });
  });
});

function plugin(
  pluginId: string,
  path: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pluginId,
    name: "flowrivet",
    marketplaceName: pluginId.split("@")[1],
    version: "0.1.0",
    installed: true,
    enabled: true,
    source: { source: "local", path },
    marketplaceSource: { sourceType: "local", source: "/marketplace" },
    ...overrides,
  };
}

function pluginList(installed: Record<string, unknown>[]): string {
  return JSON.stringify({ installed, available: [] });
}
