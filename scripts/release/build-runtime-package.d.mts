export interface BuildRuntimePackageOptions {
  runtimeDirectory: string;
  appDirectory: string;
  outputDirectory: string;
  version: string;
  platform: string;
  protocolVersion: number;
}

export function buildRuntimePackage(options: BuildRuntimePackageOptions): Promise<{
  schemaVersion: 1;
  version: string;
  platform: string;
  protocolVersion: number;
}>;
