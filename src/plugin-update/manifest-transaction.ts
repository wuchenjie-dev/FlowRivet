import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import { PluginUpdateError } from "./contracts.js";

export interface ManifestTransactionOptions {
  sourceRoot: string;
  manifestPath: string;
  transactionDirectory: string;
  originalManifest: Buffer;
  temporaryManifest: Buffer;
  isProcessAlive?: (pid: number) => boolean;
}

export interface ManifestTransactionPaths {
  directory: string;
  backupPath: string;
  journalPath: string;
  lockPath: string;
}

export type ManifestRecoveryOptions = Pick<
  ManifestTransactionOptions,
  "sourceRoot" | "manifestPath" | "transactionDirectory" | "isProcessAlive"
>;

interface ManifestJournal {
  version: 1;
  sourcePath: string;
  manifestPath: string;
  backupPath: string;
  originalHash: string;
  temporaryHash: string;
  createdAt: string;
  state: "prepared" | "applied";
}

export async function runManifestTransaction<T>(
  options: ManifestTransactionOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const paths = getManifestTransactionPaths(
    options.sourceRoot,
    options.transactionDirectory,
  );
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(paths.lockPath, options.isProcessAlive ?? isProcessAlive);
  let operationError: unknown;

  try {
    await recoverInterruptedTransaction(paths, options.manifestPath);
    const current = await readFile(options.manifestPath);
    if (hashManifest(current) !== hashManifest(options.originalManifest)) {
      throw recoveryConflict("manifest 在事务开始前发生变化");
    }

    const journal: ManifestJournal = {
      version: 1,
      sourcePath: options.sourceRoot,
      manifestPath: options.manifestPath,
      backupPath: paths.backupPath,
      originalHash: hashManifest(options.originalManifest),
      temporaryHash: hashManifest(options.temporaryManifest),
      createdAt: new Date().toISOString(),
      state: "prepared",
    };
    await atomicWrite(paths.backupPath, options.originalManifest);
    await atomicWrite(paths.journalPath, Buffer.from(`${JSON.stringify(journal)}\n`));
    await atomicWrite(options.manifestPath, options.temporaryManifest);
    await atomicWrite(paths.journalPath, Buffer.from(`${JSON.stringify({
      ...journal,
      state: "applied",
    })}\n`));

    try {
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await restoreOriginal(paths, options.manifestPath, options.originalManifest);
      } catch (restoreError) {
        throw new PluginUpdateError(
          "plugin_manifest_restore_failed",
          "插件安装后无法恢复原始 manifest",
          { cause: restoreError ?? operationError },
        );
      }
    }
  } finally {
    await releaseLock(lock, paths.lockPath);
  }
}

export async function recoverManifestTransaction(
  options: ManifestRecoveryOptions,
): Promise<void> {
  const paths = getManifestTransactionPaths(
    options.sourceRoot,
    options.transactionDirectory,
  );
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(paths.lockPath, options.isProcessAlive ?? isProcessAlive);
  try {
    await recoverInterruptedTransaction(paths, options.manifestPath);
  } finally {
    await releaseLock(lock, paths.lockPath);
  }
}

export function getManifestTransactionPaths(
  sourceRoot: string,
  transactionDirectory: string,
): ManifestTransactionPaths {
  const sourceKey = createHash("sha256").update(sourceRoot).digest("hex").slice(0, 16);
  const directory = join(transactionDirectory, "plugin-updates", sourceKey);
  return {
    directory,
    backupPath: join(directory, "manifest.backup"),
    journalPath: join(directory, "transaction.json"),
    lockPath: join(directory, "update.lock"),
  };
}

export function hashManifest(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function recoverInterruptedTransaction(
  paths: ManifestTransactionPaths,
  manifestPath: string,
): Promise<void> {
  let journal: ManifestJournal;
  try {
    journal = JSON.parse(await readFile(paths.journalPath, "utf8")) as ManifestJournal;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw recoveryConflict("无法读取遗留的 manifest 事务日志", error);
  }
  if (!isValidJournal(journal, manifestPath, paths.backupPath)) {
    throw recoveryConflict("遗留的 manifest 事务日志格式无效");
  }

  const currentHash = hashManifest(await readFile(manifestPath));
  if (currentHash === journal.originalHash) {
    await cleanupTransactionEvidence(paths);
    return;
  }
  if (currentHash !== journal.temporaryHash) {
    throw recoveryConflict("manifest 与遗留事务的原始和临时哈希均不匹配");
  }

  const backup = await readFile(paths.backupPath);
  if (hashManifest(backup) !== journal.originalHash) {
    throw recoveryConflict("遗留事务备份的哈希不匹配");
  }
  await atomicWrite(manifestPath, backup);
  if (hashManifest(await readFile(manifestPath)) !== journal.originalHash) {
    throw recoveryConflict("恢复 manifest 后哈希校验失败");
  }
  await cleanupTransactionEvidence(paths);
}

async function restoreOriginal(
  paths: ManifestTransactionPaths,
  manifestPath: string,
  originalManifest: Buffer,
): Promise<void> {
  await atomicWrite(manifestPath, originalManifest);
  if (hashManifest(await readFile(manifestPath)) !== hashManifest(originalManifest)) {
    throw new Error("restored manifest hash mismatch");
  }
  await cleanupTransactionEvidence(paths);
}

async function cleanupTransactionEvidence(paths: ManifestTransactionPaths): Promise<void> {
  await rm(paths.journalPath, { force: true });
  await rm(paths.backupPath, { force: true });
}

async function atomicWrite(path: string, contents: Buffer): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireLock(
  lockPath: string,
  processAlive: (pid: number) => boolean,
): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      return handle;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const owner = await readLockOwner(lockPath);
      if (owner !== undefined && processAlive(owner)) {
        throw new PluginUpdateError(
          "plugin_update_in_progress",
          `另一个 FlowRivet 插件更新正在运行（PID ${owner}）`,
        );
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new PluginUpdateError("plugin_update_in_progress", "无法获取插件更新锁");
}

async function readLockOwner(lockPath: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    return Number.isInteger(value.pid) && (value.pid as number) > 0
      ? value.pid as number
      : undefined;
  } catch {
    return undefined;
  }
}

async function releaseLock(handle: FileHandle, lockPath: string): Promise<void> {
  await handle.close().catch(() => undefined);
  await rm(lockPath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function isValidJournal(
  value: ManifestJournal,
  manifestPath: string,
  backupPath: string,
): boolean {
  return value?.version === 1 &&
    value.manifestPath === manifestPath &&
    value.backupPath === backupPath &&
    typeof value.sourcePath === "string" &&
    typeof value.originalHash === "string" &&
    typeof value.temporaryHash === "string" &&
    typeof value.createdAt === "string" &&
    (value.state === "prepared" || value.state === "applied");
}

function recoveryConflict(message: string, cause?: unknown): PluginUpdateError {
  return new PluginUpdateError(
    "plugin_manifest_recovery_conflict",
    message,
    { cause },
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
