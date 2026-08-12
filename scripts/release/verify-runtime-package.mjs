import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyRuntimePackage(directory, platform) {
  const nodeName = platform.startsWith("win32") ? "node.exe" : "node";
  for (const path of [
    join(directory, "runtime", nodeName),
    join(directory, "runtime", "LICENSE"),
    join(directory, "app", "packages", "codex-plugin", "dist"),
    join(directory, "app", "packages", "updater", "dist"),
    join(directory, "release-metadata.json"),
  ]) await access(path);
  const metadata = JSON.parse(await readFile(join(directory, "release-metadata.json"), "utf8"));
  if (metadata.platform !== platform) throw new Error("runtime_platform_mismatch");
  return metadata;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  await verifyRuntimePackage(requiredEnvironment("FLOWRIVET_PACKAGE_DIRECTORY"), requiredEnvironment("FLOWRIVET_TARGET_PLATFORM"));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}
