import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { extract as extractTar, list as listTar, type ReadEntry } from "tar";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export interface ArchiveEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "hardlink" | "device";
  size: number;
}

export interface ExtractArchiveOptions {
  archivePath: string;
  destination: string;
  format: "tar.gz" | "zip";
  limits: {
    maxFiles: number;
    maxExpandedBytes: number;
    maxCompressionRatio: number;
  };
  allowedTopLevel: string[];
}

export async function extractArchive(options: ExtractArchiveOptions): Promise<void> {
  const archiveBytes = (await stat(options.archivePath)).size;
  const entries = options.format === "tar.gz"
    ? await inspectTar(options.archivePath)
    : await inspectZip(options.archivePath);
  validateArchiveEntries(entries, options.limits);
  validatePackageLayout(entries, options.allowedTopLevel);
  const expandedBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (archiveBytes === 0 || expandedBytes / archiveBytes > options.limits.maxCompressionRatio) {
    throw new Error("archive_compression_ratio_exceeded");
  }

  await rm(options.destination, { recursive: true, force: true });
  await mkdir(options.destination, { recursive: false, mode: 0o700 });
  try {
    if (options.format === "tar.gz") await extractValidatedTar(options.archivePath, options.destination);
    else await extractValidatedZip(options.archivePath, options.destination, options.limits);
  } catch (error) {
    await rm(options.destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function validateArchiveEntries(
  entries: ArchiveEntry[],
  limits: { maxFiles: number; maxExpandedBytes: number },
): void {
  if (entries.length > limits.maxFiles) throw new Error("archive_too_many_files");
  const seen = new Set<string>();
  let expandedBytes = 0;
  for (const entry of entries) {
    const normalized = normalizeEntryPath(entry.path, entry.type);
    if (
      entry.type !== "file" && entry.type !== "directory"
      || entry.size < 0 || !Number.isSafeInteger(entry.size)
      || normalized.startsWith("/")
      || normalized.startsWith("//")
      || /^[A-Za-z]:\//u.test(normalized)
      || normalized.split("/").some((segment) => segment === ".." || segment === "")
    ) throw new Error("archive_entry_unsafe");
    if (seen.has(normalized)) throw new Error("archive_entry_duplicate");
    seen.add(normalized);
    expandedBytes += entry.size;
    if (expandedBytes > limits.maxExpandedBytes) throw new Error("archive_too_large");
  }
}

function validatePackageLayout(entries: ArchiveEntry[], allowedTopLevel: string[]): void {
  const allowed = new Set(allowedTopLevel);
  for (const entry of entries) {
    const [topLevel] = normalizeEntryPath(entry.path, entry.type).split("/");
    if (!topLevel || !allowed.has(topLevel)) throw new Error("archive_layout_invalid");
  }
}

async function inspectTar(archivePath: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await listTar({
    file: archivePath,
    gzip: true,
    onReadEntry: (entry: ReadEntry) => {
      entries.push({
        path: entry.path,
        type: tarEntryType(entry.type),
        size: entry.size,
      });
      entry.resume();
    },
  });
  return entries;
}

async function extractValidatedTar(archivePath: string, destination: string): Promise<void> {
  await extractTar({
    file: archivePath,
    cwd: destination,
    gzip: true,
    preservePaths: false,
    strict: true,
    filter: (path, entry) => {
      if (!("type" in entry)) throw new Error("archive_entry_unsafe");
      validateArchiveEntries([{
        path,
        type: tarEntryType(entry.type),
        size: entry.size,
      }], { maxFiles: 1, maxExpandedBytes: Number.MAX_SAFE_INTEGER });
      return true;
    },
  });
}

function tarEntryType(type: string): ArchiveEntry["type"] {
  if (type === "File" || type === "OldFile" || type === "ContiguousFile") return "file";
  if (type === "Directory") return "directory";
  if (type === "SymbolicLink") return "symlink";
  if (type === "Link") return "hardlink";
  return "device";
}

async function inspectZip(archivePath: string): Promise<ArchiveEntry[]> {
  const zip = await openZip(archivePath);
  return new Promise<ArchiveEntry[]>((resolveEntries, reject) => {
    const entries: ArchiveEntry[] = [];
    zip.on("entry", (entry: Entry) => {
      entries.push(zipEntry(entry));
      zip.readEntry();
    });
    zip.once("end", () => resolveEntries(entries));
    zip.once("error", reject);
    zip.readEntry();
  }).finally(() => zip.close());
}

async function extractValidatedZip(
  archivePath: string,
  destination: string,
  limits: ExtractArchiveOptions["limits"],
): Promise<void> {
  const zip = await openZip(archivePath);
  let fileCount = 0;
  let expandedBytes = 0;
  try {
    await new Promise<void>((resolveExtraction, reject) => {
      const fail = (error: unknown) => reject(error);
      zip.once("error", fail);
      zip.once("end", resolveExtraction);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const declared = zipEntry(entry);
          validateArchiveEntries([declared], { maxFiles: 1, maxExpandedBytes: limits.maxExpandedBytes });
          fileCount += 1;
          expandedBytes += declared.size;
          if (fileCount > limits.maxFiles) throw new Error("archive_too_many_files");
          if (expandedBytes > limits.maxExpandedBytes) throw new Error("archive_too_large");
          const outputPath = safeOutputPath(destination, declared.path, declared.type);
          if (declared.type === "directory") {
            await mkdir(outputPath, { recursive: true, mode: 0o700 });
          } else {
            await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
            const input = await openZipEntry(zip, entry);
            await pipeline(input, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("archive_open_failed"));
      else resolveZip(zip);
    });
  });
}

function openZipEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("archive_entry_open_failed"));
      else resolveStream(stream);
    });
  });
}

function zipEntry(entry: Entry): ArchiveEntry {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  const directory = entry.fileName.endsWith("/") || unixType === 0o040000;
  const type: ArchiveEntry["type"] = unixType === 0o120000
    ? "symlink"
    : directory
      ? "directory"
      : unixType !== 0 && unixType !== 0o100000
        ? "device"
        : "file";
  return { path: entry.fileName, type, size: entry.uncompressedSize };
}

function normalizeEntryPath(path: string, type: ArchiveEntry["type"]): string {
  const normalized = path.replace(/\\/gu, "/");
  return type === "directory" ? normalized.replace(/\/+$/u, "") : normalized;
}

function safeOutputPath(root: string, entryPath: string, type: ArchiveEntry["type"]): string {
  const normalized = normalizeEntryPath(entryPath, type);
  const output = resolve(root, ...normalized.split("/"));
  const resolvedRoot = resolve(root);
  if (output !== resolvedRoot && !output.startsWith(`${resolvedRoot}${sep}`)) throw new Error("archive_entry_unsafe");
  return output;
}
