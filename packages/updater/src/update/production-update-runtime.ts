import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isCompanionInstance } from "@flowrivet/runtime-contracts";

import { CompanionController, createSystemCompanionProcessAdapter } from "../companion/companion-controller.js";
import { JsonUpdateConfigStore } from "../config/update-config-store.js";
import { assertCompatibleRelease, channelManifestSchema, releaseManifestSchema } from "../contracts/release-manifest.js";
import { createCredentialStore } from "../credentials/index.js";
import { extractArchive } from "../download/archive-extractor.js";
import { GenericPackageClient } from "../gitlab/generic-package-client.js";
import type { UpdatePaths } from "../storage/update-paths.js";
import { UpdateStateStore } from "../storage/update-state-store.js";
import { VersionStore } from "../storage/version-store.js";
import { UpdateService } from "./update-service.js";

export function createProductionUpdateService(options: {
  paths: UpdatePaths;
  protocolVersion: number;
  updaterVersion: string;
  host?: string;
  port?: number;
  macosHelperPath?: string;
}) {
  const versionStore = new VersionStore(options.paths.root);
  const stateStore = new UpdateStateStore(options.paths.state);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 43119;
  const instancePath = join(options.paths.root, "data", "companion-instance.json");
  const controller = new CompanionController({
    versionsRoot: options.paths.versions,
    instancePath,
    logPath: join(options.paths.logs, "companion.log"),
    sharedDataRoot: join(options.paths.root, "data"),
    host,
    port,
    adapter: createSystemCompanionProcessAdapter(),
    readInstance: async () => {
      try { return JSON.parse(await readFile(instancePath, "utf8")); } catch { return undefined; }
    },
    fetchHealth: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return response.json();
    },
  });
  let releaseClient: GenericPackageClient | undefined;
  let selected: { version: string; bytes: Uint8Array; file: string; size: number; sha256: string } | undefined;

  return new UpdateService({
    currentVersion: async () => (await versionStore.readCurrent())?.activeVersion ?? "0.0.0",
    acquireLock: () => stateStore.acquire(),
    resolveRelease: async (currentVersion) => {
      const config = await new JsonUpdateConfigStore(join(options.paths.config, "updater.json")).load();
      const token = await createCredentialStore({ ...(process.platform === "darwin" ? { macosHelperPath: options.macosHelperPath } : {}) }).read(config.credentialReference);
      releaseClient = new GenericPackageClient({ baseUrl: config.gitlabBaseUrl, projectId: config.projectId, deployToken: token, redirectHostAllowlist: config.redirectHostAllowlist });
      const channel = channelManifestSchema.parse(JSON.parse(new TextDecoder().decode(await releaseClient.downloadChannelManifest(config.channelPackageName, config.channelVersion))));
      const release = releaseManifestSchema.parse(JSON.parse(new TextDecoder().decode(await releaseClient.downloadReleaseManifest(config.runtimePackageName, channel.version))));
      assertCompatibleRelease(channel, release, currentVersion, options.protocolVersion);
      const platform = platformIdentifier();
      const packageEntry = release.packages[platform];
      if (!packageEntry) throw new Error("platform_package_missing");
      selected = { version: release.version, bytes: new Uint8Array(), file: packageEntry.file, size: packageEntry.size, sha256: packageEntry.sha256 };
      return { version: release.version };
    },
    isCoolingDown: async (version) => {
      const failure = (await stateStore.load()).failedVersions[version];
      return Boolean(failure && Date.parse(failure.cooldownUntil) > Date.now());
    },
    stage: async (version) => {
      if (!releaseClient || !selected || selected.version !== version) throw new Error("release_not_resolved");
      const config = await new JsonUpdateConfigStore(join(options.paths.config, "updater.json")).load();
      const bytes = await releaseClient.downloadPackageFile(config.runtimePackageName, version, selected.file, selected.size);
      if (bytes.byteLength !== selected.size) throw new Error("package_size_mismatch");
      if (createHash("sha256").update(bytes).digest("hex") !== selected.sha256) throw new Error("package_integrity_failed");
      const transaction = await versionStore.createStaging(version);
      const archivePath = join(transaction, selected.file);
      const extracted = join(options.paths.downloads, `${version}-extracted`);
      try {
        await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
        await extractArchive({ archivePath, destination: extracted, format: selected.file.endsWith(".zip") ? "zip" : "tar.gz", limits: { maxFiles: 100_000, maxExpandedBytes: 2_000_000_000, maxCompressionRatio: 500 }, allowedTopLevel: ["runtime", "app", "release-metadata.json"] });
        await versionStore.commitStaging(version, extracted);
      } finally {
        await rm(transaction, { recursive: true, force: true });
      }
    },
    stopCurrent: () => controller.stopCurrent(),
    startVersion: (version) => controller.startVersion(version),
    activate: async (version, previousVersion) => versionStore.activate(version, previousVersion === "0.0.0" ? undefined : previousVersion),
    recordSuccess: async (version) => {
      const state = await stateStore.load();
      delete state.failedVersions[version];
      await stateStore.save({ ...state, lastSuccessfulVersion: version });
    },
    recordFailure: async (version, errorCode) => {
      const state = await stateStore.load();
      const failedAt = new Date();
      await stateStore.save({ ...state, failedVersions: { ...state.failedVersions, [version]: { failedAt: failedAt.toISOString(), cooldownUntil: new Date(failedAt.getTime() + 24 * 60 * 60_000).toISOString(), errorCode } } });
    },
  });
}

function platformIdentifier(): string {
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${process.platform}-${arch}`;
}
