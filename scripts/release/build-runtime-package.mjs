import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PLATFORMS = new Set(["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]);

export async function buildRuntimePackage(options) {
  if (!SEMVER.test(options.version) || !PLATFORMS.has(options.platform)) throw new Error("release_metadata_invalid");
  await rm(options.outputDirectory, { recursive: true, force: true });
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
  await copyRequiredDirectory(options.runtimeDirectory, join(options.outputDirectory, "runtime"));
  for (const packageName of ["codex-plugin", "updater", "runtime-contracts"]) {
    const source = join(options.appDirectory, "packages", packageName, "dist");
    try {
      await copyRequiredDirectory(source, join(options.outputDirectory, "app", "packages", packageName, "dist"));
    } catch (error) {
      if (packageName !== "runtime-contracts") throw error;
    }
  }
  if (options.platform.startsWith("darwin-")) {
    await mkdir(join(options.outputDirectory, "app", "packages", "updater", "native"), { recursive: true });
    await cp(
      join(options.appDirectory, "packages", "updater", "native", "macos-keychain-helper"),
      join(options.outputDirectory, "app", "packages", "updater", "native", "macos-keychain-helper"),
    );
  }
  for (const file of ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_LICENSES.txt"]) {
    try {
      await mkdir(join(options.outputDirectory, "app"), { recursive: true });
      await cp(join(options.appDirectory, file), join(options.outputDirectory, "app", basename(file)));
    } catch (error) {
      if (file === "package.json" || file === "package-lock.json") throw error;
    }
  }
  try {
    await copyRequiredDirectory(join(options.appDirectory, "node_modules"), join(options.outputDirectory, "app", "node_modules"));
  } catch {
    // CI may assemble production dependencies in a later isolated step.
  }
  const sharedPackage = join(options.outputDirectory, "app", "node_modules", "@flowrivet", "runtime-contracts");
  await rm(sharedPackage, { recursive: true, force: true });
  await copyRequiredDirectory(join(options.appDirectory, "packages", "runtime-contracts", "dist"), join(sharedPackage, "dist"));
  await writeFile(join(sharedPackage, "package.json"), `${JSON.stringify({
    name: "@flowrivet/runtime-contracts",
    version: options.version,
    type: "module",
    exports: { ".": "./dist/index.js" },
  }, null, 2)}\n`, { mode: 0o600 });
  const metadata = {
    schemaVersion: 1,
    version: options.version,
    platform: options.platform,
    protocolVersion: options.protocolVersion,
  };
  await writeFile(join(options.outputDirectory, "release-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return metadata;
}

async function copyRequiredDirectory(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: (path) => !/(?:^|[\\/])(?:\.git|tests?|logs?|cache|coverage)(?:[\\/]|$)|\.map$/u.test(path),
  });
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  await buildRuntimePackage({
    runtimeDirectory: requiredEnvironment("FLOWRIVET_NODE_RUNTIME_DIR"),
    appDirectory: requiredEnvironment("FLOWRIVET_APP_DIRECTORY"),
    outputDirectory: requiredEnvironment("FLOWRIVET_PACKAGE_DIRECTORY"),
    version: normalizeTag(requiredEnvironment("CI_COMMIT_TAG")),
    platform: requiredEnvironment("FLOWRIVET_TARGET_PLATFORM"),
    protocolVersion: Number(process.env.FLOWRIVET_PROTOCOL_VERSION ?? "1"),
  });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function normalizeTag(tag) {
  return tag.replace(/^v/u, "");
}
