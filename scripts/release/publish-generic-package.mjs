import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function publishGenericRelease(options) {
  if (new URL(options.baseUrl).protocol !== "https:") throw new Error("registry_url_insecure");
  const immutableBase = registryBase(options.baseUrl, options.projectId, "flowrivet-runtime", options.version);
  for (const file of [...options.files, { name: "release-manifest.json", bytes: options.manifestBytes }]) {
    const url = `${immutableBase}/${encodeURIComponent(file.name)}`;
    const put = await options.fetch(url, { method: "PUT", headers: { "JOB-TOKEN": options.jobToken }, body: file.bytes });
    if (!put.ok) throw new Error(put.status === 409 ? "release_version_exists" : "release_upload_failed");
    const get = await options.fetch(url, { headers: { "JOB-TOKEN": options.jobToken } });
    if (!get.ok) throw new Error("release_readback_failed");
    const returned = new Uint8Array(await get.arrayBuffer());
    if (hash(returned) !== hash(file.bytes)) throw new Error("release_readback_mismatch");
  }
  const channelUrl = `${registryBase(options.baseUrl, options.projectId, "flowrivet-channel", "latest")}/manifest.json`;
  const pointer = await options.fetch(channelUrl, { method: "PUT", headers: { "JOB-TOKEN": options.jobToken }, body: options.manifestBytes });
  if (!pointer.ok) throw new Error("channel_publish_failed");
}

function registryBase(baseUrl, projectId, packageName, version) {
  return `${String(baseUrl).replace(/\/$/u, "")}/api/v4/projects/${encodeURIComponent(projectId)}/packages/generic/${packageName}/${version}`;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const directory = resolve(process.env.FLOWRIVET_RELEASE_OUTPUT ?? "release-output");
  const names = (await readdir(directory)).filter((name) => /^flowrivet-runtime-.+\.(?:zip|tar\.gz)$/u.test(name)).sort();
  const files = await Promise.all(names.map(async (name) => ({ name: basename(name), bytes: new Uint8Array(await readFile(join(directory, name))) })));
  await publishGenericRelease({
    baseUrl: requiredEnvironment("CI_SERVER_URL"),
    projectId: requiredEnvironment("CI_PROJECT_ID"),
    version: requiredEnvironment("CI_COMMIT_TAG").replace(/^v/u, ""),
    jobToken: requiredEnvironment("CI_JOB_TOKEN"),
    files,
    manifestBytes: new Uint8Array(await readFile(join(directory, "manifest.json"))),
    fetch,
  });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}
