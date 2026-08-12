export interface CreateReleaseManifestOptions {
  tag: string;
  publishedAt: string;
  protocolVersion: number;
  minimumUpdaterVersion: string;
  releaseSeverity?: "normal" | "critical";
  packages: Record<string, string>;
}

export function createReleaseManifest(options: CreateReleaseManifestOptions): Promise<{
  manifest: {
    version: string;
    packages: Record<string, { sha256: string; size: number; file: string }>;
  };
  channelBytes: Uint8Array;
  releaseBytes: Uint8Array;
}>;
