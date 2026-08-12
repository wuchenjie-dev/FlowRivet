import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.env.FLOWRIVET_RELEASE_OUTPUT ?? "release-output");
const manifest = JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8"));
for (const [platform, entry] of Object.entries(manifest.packages)) {
  const bytes = await readFile(join(root, entry.file));
  if (bytes.byteLength !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error(`release_verification_failed_${platform}`);
  }
}
if (Object.keys(manifest.packages).length < 3) throw new Error("release_platforms_incomplete");
