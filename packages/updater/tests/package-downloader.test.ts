import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { downloadVerifiedPackage } from "../src/download/package-downloader.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("verified package download", () => {
  it("streams a package to disk and verifies size and SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowrivet-download-"));
    roots.push(root);
    const path = join(root, "package.bin");
    const body = new TextEncoder().encode("verified package");
    await downloadVerifiedPackage(new Response(body), path, {
      size: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      maxBytes: 1024,
    });
    await expect(readFile(path)).resolves.toEqual(Buffer.from(body));
  });

  it("removes partial output on size or digest mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowrivet-download-"));
    roots.push(root);
    const path = join(root, "package.bin");
    await expect(downloadVerifiedPackage(new Response("bad"), path, {
      size: 3,
      sha256: "a".repeat(64),
      maxBytes: 2,
    })).rejects.toThrow("package_too_large");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
