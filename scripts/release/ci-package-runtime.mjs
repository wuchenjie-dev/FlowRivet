import { readFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extract, create } from "tar";

import { buildRuntimePackage } from "./build-runtime-package.mjs";
import { resolveRuntimeArchive } from "./runtime-archive-source.mjs";
import { verifyRuntimePackage } from "./verify-runtime-package.mjs";

const platform = required("FLOWRIVET_TARGET_PLATFORM");
const inventory = JSON.parse(await readFile(new URL("./runtime-checksums.json", import.meta.url), "utf8"));
const scratch = resolve("release-work", platform);
await rm(scratch, { recursive: true, force: true });
const archive = await resolveRuntimeArchive({
  platform,
  inventory,
  downloadDirectory: join(scratch, "downloads"),
  ...(process.env.FLOWRIVET_NODE_RUNTIME_ARCHIVE
    ? { localArchive: process.env.FLOWRIVET_NODE_RUNTIME_ARCHIVE }
    : {}),
  fetch,
});
const runtime = join(scratch, "runtime-source");
const packageDirectory = join(scratch, "package");
await mkdir(runtime, { recursive: true });
await extract({ file: archive, cwd: runtime, strict: true, preservePaths: false });
await buildRuntimePackage({ runtimeDirectory: runtime, appDirectory: resolve("."), outputDirectory: packageDirectory, version: required("CI_COMMIT_TAG").replace(/^v/u, ""), platform, protocolVersion: 1 });
await verifyRuntimePackage(packageDirectory, platform);
await mkdir("release-output", { recursive: true });
await create({ cwd: packageDirectory, file: join("release-output", `flowrivet-runtime-${platform}-${required("CI_COMMIT_TAG")}.tar.gz`), gzip: true, portable: true, mtime: new Date(0) }, ["."]);

function required(name) { const value = process.env[name]; if (!value) throw new Error(`missing_${name.toLowerCase()}`); return value; }
