import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

export const COMPANION_PRODUCT = "flowrivet-companion";

export interface CompanionHealth {
  product: typeof COMPANION_PRODUCT;
  pid: number;
  instanceId: string;
}

export interface CompanionInstance extends CompanionHealth {
  version: 1;
  processStartedAt: string;
  host: string;
  port: number;
  startedAt: string;
}

export function resolveCompanionInstancePath(options: {
  platform?: NodeJS.Platform;
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const explicit = environment.FLOWRIVET_COMPANION_INSTANCE_FILE;
  if (explicit) return explicit;
  const homeDirectory = options.homeDirectory ?? homedir();

  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA is required on Windows");
    return win32.join(localAppData, "FlowRivet", "companion-instance.json");
  }
  if (platform === "darwin") {
    return posix.join(
      homeDirectory,
      "Library",
      "Application Support",
      "FlowRivet",
      "companion-instance.json",
    );
  }
  const configDirectory = environment.XDG_CONFIG_HOME
    ? posix.join(environment.XDG_CONFIG_HOME, "flowrivet")
    : posix.join(homeDirectory, ".config", "flowrivet");
  return posix.join(configDirectory, "companion-instance.json");
}

export async function writeCompanionInstance(
  path: string,
  instance: CompanionInstance,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(instance)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readCompanionInstance(
  path: string,
): Promise<CompanionInstance | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isCompanionInstance(value) ? value : undefined;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    return undefined;
  }
}

export async function removeCompanionInstance(
  path: string,
  owner: CompanionHealth,
): Promise<void> {
  const current = await readCompanionInstance(path);
  if (
    current?.product === owner.product &&
    current.pid === owner.pid &&
    current.instanceId === owner.instanceId
  ) {
    await rm(path, { force: true });
  }
}

function isCompanionInstance(value: unknown): value is CompanionInstance {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CompanionInstance>;
  return candidate.version === 1 &&
    candidate.product === COMPANION_PRODUCT &&
    Number.isInteger(candidate.pid) &&
    (candidate.pid ?? 0) > 0 &&
    typeof candidate.processStartedAt === "string" &&
    typeof candidate.host === "string" &&
    Number.isInteger(candidate.port) &&
    (candidate.port ?? 0) > 0 &&
    typeof candidate.instanceId === "string" &&
    candidate.instanceId.length > 0 &&
    typeof candidate.startedAt === "string";
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
