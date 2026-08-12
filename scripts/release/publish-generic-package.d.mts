export interface PublishGenericReleaseOptions {
  baseUrl: string;
  projectId: string;
  version: string;
  jobToken: string;
  files: Array<{ name: string; bytes: Uint8Array }>;
  manifestBytes: Uint8Array;
  fetch: typeof fetch;
}

export function publishGenericRelease(options: PublishGenericReleaseOptions): Promise<void>;
