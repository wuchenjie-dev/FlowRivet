import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  defaultTaskboardPreferences,
  taskboardPreferencesSchema,
  type TaskboardPreferences,
} from "../contracts/taskboard-preferences.js";
import {
  TaskboardPreferencesStoreError,
  type TaskboardPreferencesStore,
} from "./taskboard-preferences-store.js";

const envelopeSchema = z.object({
  version: z.literal(1),
  preferences: taskboardPreferencesSchema,
}).strict();

type RenameFile = typeof rename;

export class JsonTaskboardPreferencesStore implements TaskboardPreferencesStore {
  private readonly path: string;
  private readonly renameFile: RenameFile;

  constructor(options: { directory: string; renameFile?: RenameFile }) {
    this.path = join(options.directory, "taskboard-preferences.json");
    this.renameFile = options.renameFile ?? rename;
  }

  async load(): Promise<TaskboardPreferences> {
    try {
      const contents = await readFile(this.path, "utf8");
      return envelopeSchema.parse(JSON.parse(contents)).preferences;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { ...defaultTaskboardPreferences };
      if (error instanceof TaskboardPreferencesStoreError) throw error;
      throw new TaskboardPreferencesStoreError("taskboard_preferences_read_failed");
    }
  }

  async save(preferences: TaskboardPreferences): Promise<void> {
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      const envelope = envelopeSchema.parse({ version: 1, preferences });
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, "utf8");
      await this.renameFile(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof TaskboardPreferencesStoreError) throw error;
      throw new TaskboardPreferencesStoreError("taskboard_preferences_write_failed");
    }
  }
}

function isNodeError(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
