import { describe, expect, it } from "vitest";

import { resolveUpdatePaths } from "../src/storage/update-paths.js";

describe("updater paths", () => {
  it.each([
    ["win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test", "C:\\Users\\test\\AppData\\Local\\FlowRivet"],
    ["darwin", {}, "/Users/test", "/Users/test/Library/Application Support/FlowRivet"],
    ["linux", { XDG_DATA_HOME: "/data" }, "/home/test", "/data/flowrivet"],
  ] as const)("resolves %s paths below one application root", (platform, environment, home, root) => {
    const paths = resolveUpdatePaths({ platform, environment, homeDirectory: home });
    expect(paths.root).toBe(root);
    for (const value of Object.values(paths)) expect(value.startsWith(root)).toBe(true);
  });
});
