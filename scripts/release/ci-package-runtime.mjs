import { createHash } from "node:crypto";
import { readFile, mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { extract, create } from "tar";

import { buildRuntimePackage } from "./build-runtime-package.mjs";
import { verifyRuntimePackage } from "./verify-runtime-package.mjs";

const platform = required("FLOWRIVET_TARGET_PLATFORM");
const archive = resolve(required("FLOWRIVET_NODE_RUNTIME_ARCHIVE"));
const inventory = JSON.parse(await readFile(new URL("./runtime-checksums.json", import.meta.url), "utf8"));
const expected = inventory.artifacts[platform];
if (!expected || expected.sha256 !== createHash("sha256").update(await readFile(archive)).digest("hex")) {
  throw new Error("runtime_checksum_untrusted");
}
const scratch = resolve("release-work", platform);
const runtime = join(scratch, "runtime-source");
const packageDirectory = join(scratch, "package");
await rm(scratch, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
await extract({ file: archive, cwd: runtime, strict: true, preservePaths: false });
await buildRuntimePackage({ runtimeDirectory: runtime, appDirectory: resolve("."), outputDirectory: packageDirectory, version: required("CI_COMMIT_TAG").replace(/^v/u, ""), platform, protocolVersion: 1 });
await verifyRuntimePackage(packageDirectory, platform);
await mkdir("release-output", { recursive: true });
await create({ cwd: packageDirectory, file: join("release-output", `flowrivet-runtime-${platform}-${required("CI_COMMIT_TAG")}.tar.gz`), gzip: true, portable: true, mtime: new Date(0) }, ["."]);

function required(name) { const value = process.env[name]; if (!value) throw new Error(`missing_${name.toLowerCase()}`); return value; }
