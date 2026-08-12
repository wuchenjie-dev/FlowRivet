export interface RuntimeArtifactInventory {
  schemaVersion: number;
  nodeVersion: string;
  artifacts: Record<string, {
    url: string;
    file: string;
    size?: number;
    sha256: string;
  }>;
}

export function resolveRuntimeArchive(options: {
  platform: string;
  inventory: RuntimeArtifactInventory;
  downloadDirectory: string;
  localArchive?: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<string>;
