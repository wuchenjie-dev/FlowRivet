import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function createReleaseManifest(options) {
  const version = String(options.tag).replace(/^v/u, "");
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) throw new Error("release_tag_invalid");
  const packages = {};
  for (const platform of Object.keys(options.packages).sort()) {
    const path = options.packages[platform];
    const bytes = new Uint8Array(await readFile(path));
    packages[platform] = {
      packageName: "flowrivet-runtime",
      packageVersion: version,
      file: basename(path),
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const manifest = {
    schemaVersion: 1,
    channel: "stable",
    version,
    publishedAt: options.publishedAt,
    minimumUpdaterVersion: options.minimumUpdaterVersion,
    protocolVersion: options.protocolVersion,
    releaseSeverity: options.releaseSeverity ?? "normal",
    packages,
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, channelBytes: bytes, releaseBytes: bytes.slice() };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const directory = resolve(process.env.FLOWRIVET_RELEASE_OUTPUT ?? "release-output");
  const files = (await readdir(directory)).filter((file) => /^flowrivet-runtime-.+\.(?:zip|tar\.gz)$/u.test(file));
  const packages = Object.fromEntries(files.map((file) => {
    const match = file.match(/^flowrivet-runtime-(.+?)-(?:v?\d+\.\d+\.\d+)\.(?:zip|tar\.gz)$/u);
    if (!match) throw new Error("release_filename_invalid");
    return [match[1], join(directory, file)];
  }));
  const result = await createReleaseManifest({
    tag: requiredEnvironment("CI_COMMIT_TAG"),
    publishedAt: process.env.CI_PIPELINE_CREATED_AT ?? new Date().toISOString(),
    protocolVersion: Number(process.env.FLOWRIVET_PROTOCOL_VERSION ?? "1"),
    minimumUpdaterVersion: process.env.FLOWRIVET_MINIMUM_UPDATER_VERSION ?? "0.1.0",
    packages,
  });
  await writeFile(join(directory, "release-manifest.json"), result.releaseBytes);
  await writeFile(join(directory, "manifest.json"), result.channelBytes);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}
