import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { currentVersionSchema, type CurrentVersion } from "../contracts/update-state.js";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export class VersionStore {
  constructor(private readonly root: string) {}

  async createStaging(version: string): Promise<string> {
    assertVersion(version);
    const downloads = join(this.root, "downloads");
    await mkdir(downloads, { recursive: true, mode: 0o700 });
    const path = join(downloads, `${version}-${randomUUID()}`);
    await mkdir(path, { recursive: false, mode: 0o700 });
    return path;
  }

  async commitStaging(version: string, stagingPath: string): Promise<string> {
    assertVersion(version);
    const versions = join(this.root, "versions");
    const target = join(versions, version);
    await mkdir(versions, { recursive: true, mode: 0o700 });
    try {
      await access(target);
      throw new Error("version_exists");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    try {
      await rename(stagingPath, target);
    } catch (error) {
      if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) throw new Error("version_exists");
      throw error;
    }
    return target;
  }

  async activate(activeVersion: string, previousVersion: string | undefined, at = new Date()): Promise<void> {
    assertVersion(activeVersion);
    if (previousVersion) assertVersion(previousVersion);
    const value = currentVersionSchema.parse({
      schemaVersion: 1,
      activeVersion,
      ...(previousVersion ? { previousVersion } : {}),
      activatedAt: at.toISOString(),
    });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.root, `current.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, join(this.root, "current.json"));
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readCurrent(): Promise<CurrentVersion | undefined> {
    try {
      return currentVersionSchema.parse(JSON.parse(await readFile(join(this.root, "current.json"), "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }
}

function assertVersion(version: string): void {
  if (!SEMVER.test(version)) throw new Error("version_invalid");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
