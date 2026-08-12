import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveRuntimeArchive } from "../scripts/release/runtime-archive-source.mjs";

const bytes = new TextEncoder().encode("trusted-node-runtime");
const sha256 = createHash("sha256").update(bytes).digest("hex");

describe("runtime archive source", () => {
  it("downloads the exact pinned HTTPS archive and verifies it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-runtime-source-"));
    const fetch = vi.fn(async () => new Response(bytes, { status: 200 }));

    const path = await resolveRuntimeArchive({
      platform: "linux-x64",
      inventory: inventory("https://mirror.example/node-v22.19.0-linux-x64.tar.gz"),
      downloadDirectory: directory,
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://mirror.example/node-v22.19.0-linux-x64.tar.gz",
      { redirect: "error", signal: expect.any(AbortSignal) },
    );
    await expect(readFile(path)).resolves.toEqual(Buffer.from(bytes));
  });

  it("rejects an insecure mirror URL without making a request", async () => {
    const fetch = vi.fn();
    await expect(resolveRuntimeArchive({
      platform: "linux-x64",
      inventory: inventory("http://mirror.example/node.tar.gz"),
      downloadDirectory: tmpdir(),
      fetch,
    })).rejects.toThrow("runtime_url_insecure");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects embedded mirror credentials without making a request", async () => {
    const fetch = vi.fn();
    await expect(resolveRuntimeArchive({
      platform: "linux-x64",
      inventory: inventory("https://user:secret@mirror.example/node-v22.19.0-linux-x64.tar.gz"),
      downloadDirectory: tmpdir(),
      fetch,
    })).rejects.toThrow("runtime_url_credentials_forbidden");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects downloaded bytes that do not match the pinned hash", async () => {
    await expect(resolveRuntimeArchive({
      platform: "linux-x64",
      inventory: inventory("https://mirror.example/node-v22.19.0-linux-x64.tar.gz"),
      downloadDirectory: await mkdtemp(join(tmpdir(), "flowrivet-runtime-source-")),
      fetch: async () => new Response("corrupt-node-runtime", { status: 200 }),
    })).rejects.toThrow("runtime_checksum_untrusted");
  });

  it("allows a local override only when it matches the same pinned hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-runtime-source-"));
    const archive = join(directory, "node.tar.gz");
    await writeFile(archive, bytes);

    await expect(resolveRuntimeArchive({
      platform: "linux-x64",
      inventory: inventory("https://mirror.example/node.tar.gz"),
      localArchive: archive,
      downloadDirectory: directory,
      fetch: vi.fn(),
    })).resolves.toBe(archive);

    await writeFile(archive, "corrupt-node-runtime");
    await expect(resolveRuntimeArchive({
      platform: "linux-x64",
      inventory: inventory("https://mirror.example/node.tar.gz"),
      localArchive: archive,
      downloadDirectory: directory,
      fetch: vi.fn(),
    })).rejects.toThrow("runtime_checksum_untrusted");
  });

  it("stops an oversized download and removes its partial file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowrivet-runtime-source-"));
    const destination = join(directory, "node-v22.19.0-linux-x64.tar.gz");
    await expect(resolveRuntimeArchive({
      platform: "linux-x64",
      inventory: inventory("https://mirror.example/node-v22.19.0-linux-x64.tar.gz"),
      downloadDirectory: directory,
      fetch: async () => new Response(`${new TextDecoder().decode(bytes)}x`, { status: 200 }),
    })).rejects.toThrow("runtime_size_mismatch");
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function inventory(url: string) {
  return {
    schemaVersion: 1,
    nodeVersion: "22.19.0",
    artifacts: {
      "linux-x64": {
        url,
        file: "node-v22.19.0-linux-x64.tar.gz",
        size: bytes.byteLength,
        sha256,
      },
    },
  };
}
