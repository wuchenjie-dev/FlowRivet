import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createReleaseManifest } from "../scripts/release/create-release-manifest.mjs";

describe("release manifest script", () => {
  it("creates deterministic byte-identical channel and release manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowrivet-manifest-"));
    const linux = join(root, "linux.tar.gz");
    const windows = join(root, "windows.zip");
    await writeFile(linux, "linux");
    await writeFile(windows, "windows");
    const result = await createReleaseManifest({ tag: "v1.2.3", publishedAt: "2026-08-12T00:00:00.000Z", protocolVersion: 1, minimumUpdaterVersion: "0.1.0", packages: { "win32-x64": windows, "linux-x64": linux } });
    expect(result.channelBytes).toEqual(result.releaseBytes);
    expect(result.manifest.version).toBe("1.2.3");
    expect(Object.keys(result.manifest.packages)).toEqual(["linux-x64", "win32-x64"]);
    expect(result.manifest.packages["linux-x64"].sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
