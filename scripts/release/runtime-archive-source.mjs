import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function resolveRuntimeArchive(options) {
  const entry = options.inventory?.artifacts?.[options.platform];
  if (!entry || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    throw new Error("runtime_inventory_invalid");
  }
  if (options.localArchive) {
    const path = resolve(options.localArchive);
    await verifyArchive(path, entry);
    return path;
  }
  const url = new URL(String(entry.url ?? ""));
  if (url.protocol !== "https:") throw new Error("runtime_url_insecure");
  if (url.username || url.password) throw new Error("runtime_url_credentials_forbidden");
  const file = String(entry.file ?? "");
  if (!file || basename(file) !== file || decodeURIComponent(url.pathname.split("/").pop() ?? "") !== file) {
    throw new Error("runtime_inventory_invalid");
  }
  await mkdir(options.downloadDirectory, { recursive: true, mode: 0o700 });
  const destination = join(options.downloadDirectory, file);
  const response = await options.fetch(url.href, {
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
  if (!response.ok || !response.body) throw new Error("runtime_download_failed");
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createSizeLimiter(entry.size),
      createWriteStream(destination, { mode: 0o600 }),
    );
    await verifyArchive(destination, entry);
    return destination;
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

function createSizeLimiter(expectedSize) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (expectedSize !== undefined && received > expectedSize) {
        callback(new Error("runtime_size_mismatch"));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function verifyArchive(path, entry) {
  const info = await stat(path);
  if (entry.size !== undefined && info.size !== entry.size) throw new Error("runtime_size_mismatch");
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  if (hash.digest("hex") !== entry.sha256) throw new Error("runtime_checksum_untrusted");
}
