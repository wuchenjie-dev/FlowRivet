import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

export async function downloadVerifiedPackage(
  response: Response,
  outputPath: string,
  expected: { size: number; sha256: string; maxBytes: number },
): Promise<void> {
  if (!response.ok || !response.body) throw new Error("package_download_failed");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > expected.maxBytes) throw new Error("package_too_large");
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let bytes = 0;
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  try {
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > expected.maxBytes) throw new Error("package_too_large");
      hash.update(buffer);
      if (!output.write(buffer)) await new Promise<void>((resolve) => output.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => error ? reject(error) : resolve()));
    if (bytes !== expected.size) throw new Error("package_size_mismatch");
    if (hash.digest("hex") !== expected.sha256) throw new Error("package_integrity_failed");
  } catch (error) {
    output.destroy();
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
