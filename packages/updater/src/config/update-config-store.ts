import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { updateConfigSchema, type UpdateConfig } from "./update-config.js";

export class JsonUpdateConfigStore {
  constructor(private readonly path: string) {}

  async load(): Promise<UpdateConfig> {
    return updateConfigSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
  }

  async save(value: UpdateConfig): Promise<void> {
    const config = updateConfigSchema.parse(value);
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
