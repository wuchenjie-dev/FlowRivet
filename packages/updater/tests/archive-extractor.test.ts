import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create as createTar } from "tar";
import { describe, expect, it } from "vitest";

import { extractArchive, validateArchiveEntries } from "../src/download/archive-extractor.js";

describe("archive extraction policy", () => {
  it("accepts the declared runtime package layout", () => {
    expect(() => validateArchiveEntries([
      { path: "runtime/node.exe", type: "file", size: 100 },
      { path: "app/packages/codex-plugin/dist/server/index.js", type: "file", size: 200 },
      { path: "release-metadata.json", type: "file", size: 50 },
    ], { maxFiles: 10, maxExpandedBytes: 1000 })).not.toThrow();
  });

  it.each([
    "../escape",
    "/absolute/file",
    "C:\\escape.exe",
    "\\\\server\\share\\file",
  ])("rejects unsafe path %s", (path) => {
    expect(() => validateArchiveEntries([{ path, type: "file", size: 1 }], {
      maxFiles: 10,
      maxExpandedBytes: 1000,
    })).toThrow("archive_entry_unsafe");
  });

  it("rejects links, duplicates, excessive files, and expanded bytes", () => {
    expect(() => validateArchiveEntries([{ path: "runtime/link", type: "symlink", size: 0 }], { maxFiles: 10, maxExpandedBytes: 1000 })).toThrow("archive_entry_unsafe");
    expect(() => validateArchiveEntries([{ path: "a", type: "file", size: 1 }, { path: "a", type: "file", size: 1 }], { maxFiles: 10, maxExpandedBytes: 1000 })).toThrow("archive_entry_duplicate");
    expect(() => validateArchiveEntries([{ path: "a", type: "file", size: 1 }, { path: "b", type: "file", size: 1 }], { maxFiles: 1, maxExpandedBytes: 1000 })).toThrow("archive_too_many_files");
    expect(() => validateArchiveEntries([{ path: "a", type: "file", size: 1001 }], { maxFiles: 10, maxExpandedBytes: 1000 })).toThrow("archive_too_large");
  });

  it("extracts a validated tar.gz runtime package", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowrivet-archive-"));
    const source = join(root, "source");
    const archive = join(root, "runtime.tar.gz");
    const destination = join(root, "staging");
    await mkdir(join(source, "runtime"), { recursive: true });
    await mkdir(join(source, "app"), { recursive: true });
    await writeFile(join(source, "runtime", "node"), "runtime");
    await writeFile(join(source, "app", "server.js"), "server");
    await writeFile(join(source, "release-metadata.json"), "{}");
    await createTar({ cwd: source, file: archive, gzip: true }, ["runtime", "app", "release-metadata.json"]);

    await extractArchive({
      archivePath: archive,
      destination,
      format: "tar.gz",
      limits: { maxFiles: 10, maxExpandedBytes: 1000, maxCompressionRatio: 1000 },
      allowedTopLevel: ["runtime", "app", "release-metadata.json"],
    });

    await expect(readFile(join(destination, "runtime", "node"), "utf8")).resolves.toBe("runtime");
    await expect(readFile(join(destination, "app", "server.js"), "utf8")).resolves.toBe("server");
  });

  it("cleans the destination when an archive violates the package layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowrivet-archive-"));
    const source = join(root, "source");
    const archive = join(root, "runtime.tar.gz");
    const destination = join(root, "staging");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "unexpected.txt"), "unsafe");
    await createTar({ cwd: source, file: archive, gzip: true }, ["unexpected.txt"]);

    await expect(extractArchive({
      archivePath: archive,
      destination,
      format: "tar.gz",
      limits: { maxFiles: 10, maxExpandedBytes: 1000, maxCompressionRatio: 1000 },
      allowedTopLevel: ["runtime", "app", "release-metadata.json"],
    })).rejects.toThrow("archive_layout_invalid");
    await expect(readFile(join(destination, "unexpected.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
