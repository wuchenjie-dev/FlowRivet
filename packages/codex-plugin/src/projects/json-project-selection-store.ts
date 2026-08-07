import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import { z } from "zod";

import { projectRefSchema, type ProjectRef } from "../contracts/projects.js";
import {
  ProjectSelectionStoreError,
  type ProjectSelectionStore,
} from "./project-selection-store.js";

const envelopeSchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), z.array(projectRefSchema)),
});

type StoredSelections = z.infer<typeof envelopeSchema>;
type RenameFile = typeof rename;

export class JsonProjectSelectionStore implements ProjectSelectionStore {
  private readonly path: string;
  private readonly renameFile: RenameFile;

  constructor(options: { directory: string; renameFile?: RenameFile }) {
    this.path = join(options.directory, "project-selections.json");
    this.renameFile = options.renameFile ?? rename;
  }

  async load(providerId: string): Promise<ProjectRef[]> {
    const envelope = await this.readEnvelope();
    return envelope.providers[providerId] ?? [];
  }

  async save(providerId: string, projects: ProjectRef[]): Promise<void> {
    const envelope = await this.readEnvelope();
    await this.writeEnvelope({
      version: 1,
      providers: { ...envelope.providers, [providerId]: projects },
    });
  }

  async clear(providerId: string): Promise<void> {
    const envelope = await this.readEnvelope();
    const providers = { ...envelope.providers };
    delete providers[providerId];
    await this.writeEnvelope({ version: 1, providers });
  }

  private async readEnvelope(): Promise<StoredSelections> {
    try {
      const contents = await readFile(this.path, "utf8");
      return envelopeSchema.parse(JSON.parse(contents));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { version: 1, providers: {} };
      if (error instanceof ProjectSelectionStoreError) throw error;
      throw new ProjectSelectionStoreError();
    }
  }

  private async writeEnvelope(value: StoredSelections): Promise<void> {
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      const parsed = envelopeSchema.parse(value);
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(parsed)}\n`, "utf8");
      await this.renameFile(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof ProjectSelectionStoreError) throw error;
      throw new ProjectSelectionStoreError();
    }
  }
}

export function resolveFlowRivetConfigDirectory(options: {
  platform?: NodeJS.Platform;
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
} = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();

  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA is required on Windows");
    return win32.join(localAppData, "FlowRivet");
  }
  if (platform === "darwin") {
    return posix.join(homeDirectory, "Library", "Application Support", "FlowRivet");
  }
  return environment.XDG_CONFIG_HOME
    ? posix.join(environment.XDG_CONFIG_HOME, "flowrivet")
    : posix.join(homeDirectory, ".config", "flowrivet");
}

function isNodeError(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
