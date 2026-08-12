import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { updateStateSchema, type UpdateState } from "../contracts/update-state.js";

const EMPTY_STATE: UpdateState = { schemaVersion: 1, failedVersions: {} };

export class UpdateStateStore {
  constructor(private readonly path: string, private readonly lockPath = `${path}.lock`) {}

  async load(): Promise<UpdateState> {
    try {
      return updateStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  async save(state: UpdateState): Promise<void> {
    const value = updateStateSchema.parse(state);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async acquire(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    let handle: FileHandle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) throw new Error("update_already_running");
      throw error;
    }
    return async () => {
      await handle.close();
      await rm(this.lockPath, { force: true });
    };
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
