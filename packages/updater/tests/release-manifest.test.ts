import { describe, expect, it } from "vitest";

import {
  assertCompatibleRelease,
  channelManifestSchema,
  releaseManifestSchema,
} from "../src/contracts/release-manifest.js";

const manifest = {
  schemaVersion: 1,
  channel: "stable",
  version: "0.2.1",
  publishedAt: "2026-08-12T07:30:00.000Z",
  minimumUpdaterVersion: "0.1.0",
  protocolVersion: 1,
  releaseSeverity: "normal",
  packages: {
    "windows-x64": {
      packageName: "flowrivet-runtime",
      packageVersion: "0.2.1",
      file: "flowrivet-windows-x64.zip",
      size: 1024,
      sha256: "a".repeat(64),
    },
  },
} as const;

describe("release manifest contract", () => {
  it("accepts matching stable channel and immutable release manifests", () => {
    const channel = channelManifestSchema.parse(manifest);
    const release = releaseManifestSchema.parse(manifest);
    expect(assertCompatibleRelease(channel, release, "0.2.0", 1)).toEqual(release);
  });

  it.each([
    { ...manifest, schemaVersion: 2 },
    { ...manifest, version: "latest" },
    { ...manifest, protocolVersion: 0 },
    { ...manifest, packages: { "windows-x64": { ...manifest.packages["windows-x64"], file: "../escape.zip" } } },
    { ...manifest, packages: { "windows-x64": { ...manifest.packages["windows-x64"], sha256: "not-a-hash" } } },
    { ...manifest, packages: { "windows-x64": { ...manifest.packages["windows-x64"], packageVersion: "0.2.0" } } },
  ])("rejects unsafe manifest %#", (value) => {
    expect(channelManifestSchema.safeParse(value).success).toBe(false);
  });

  it("rejects rollback, protocol mismatch, and a different release manifest", () => {
    const channel = channelManifestSchema.parse(manifest);
    expect(() => assertCompatibleRelease(channel, releaseManifestSchema.parse({
      ...manifest,
      publishedAt: "2026-08-12T07:31:00.000Z",
    }), "0.2.0", 1)).toThrow("manifest_mismatch");
    expect(() => assertCompatibleRelease(channel, channel, "0.3.0", 1)).toThrow("version_rollback");
    expect(() => assertCompatibleRelease(channel, channel, "0.2.0", 2)).toThrow("protocol_incompatible");
  });

  it("treats a prerelease as older than the matching stable version", () => {
    const prerelease = channelManifestSchema.parse({
      ...manifest,
      version: "0.2.1-beta.1",
      packages: {
        "windows-x64": {
          ...manifest.packages["windows-x64"],
          packageVersion: "0.2.1-beta.1",
        },
      },
    });
    expect(() => assertCompatibleRelease(prerelease, prerelease, "0.2.1", 1))
      .toThrow("version_rollback");
  });
});
