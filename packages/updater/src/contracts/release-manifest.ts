import { z } from "zod";

const semver = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
const safeSegment = z.string().min(1).max(200).regex(/^[0-9A-Za-z._-]+$/u).refine((value) => value !== "." && value !== "..");
const packageEntrySchema = z.object({
  packageName: safeSegment,
  packageVersion: semver,
  file: safeSegment,
  size: z.int().positive().max(2_000_000_000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.literal("stable"),
  version: semver,
  publishedAt: z.iso.datetime(),
  minimumUpdaterVersion: semver,
  protocolVersion: z.int().positive(),
  releaseSeverity: z.enum(["normal", "critical"]),
  packages: z.record(safeSegment, packageEntrySchema).refine((value) => Object.keys(value).length > 0),
}).strict().superRefine((manifest, context) => {
  for (const [platform, packageEntry] of Object.entries(manifest.packages)) {
    if (packageEntry.packageVersion !== manifest.version) {
      context.addIssue({
        code: "custom",
        path: ["packages", platform, "packageVersion"],
        message: "Package version must match release version",
      });
    }
  }
});

export const channelManifestSchema = manifestSchema;
export const releaseManifestSchema = manifestSchema;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export function assertCompatibleRelease(
  channel: ReleaseManifest,
  release: ReleaseManifest,
  currentVersion: string,
  supportedProtocol: number,
): ReleaseManifest {
  if (JSON.stringify(channel) !== JSON.stringify(release)) throw new Error("manifest_mismatch");
  if (compareSemver(channel.version, currentVersion) < 0) throw new Error("version_rollback");
  if (channel.protocolVersion !== supportedProtocol) throw new Error("protocol_incompatible");
  return release;
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string) => {
    const [withoutBuild] = value.split("+", 1);
    const [core, prerelease] = withoutBuild!.split("-", 2);
    return { numeric: core!.split(".").map(Number), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a.numeric[index]! - b.numeric[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}
