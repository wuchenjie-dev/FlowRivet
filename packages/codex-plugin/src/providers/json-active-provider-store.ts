import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  activeProviderSchema,
  type ActiveProvider,
} from "../contracts/providers.js";
import {
  ActiveProviderStoreError,
  type ActiveProviderLoadInput,
  type ActiveProviderLoadResult,
  type ActiveProviderStore,
} from "./active-provider-store.js";

type RenameFile = typeof rename;

export class JsonActiveProviderStore implements ActiveProviderStore {
  private readonly path: string;
  private readonly renameFile: RenameFile;

  constructor(options: { directory: string; renameFile?: RenameFile }) {
    this.path = join(options.directory, "active-provider.json");
    this.renameFile = options.renameFile ?? rename;
  }

  async load(input: ActiveProviderLoadInput): Promise<ActiveProviderLoadResult> {
    try {
      const contents = await readFile(this.path, "utf8");
      const saved = activeProviderSchema.parse(JSON.parse(contents));
      if (input.registeredProviderIds.includes(saved.activeProviderId)) return saved;
      return {
        version: 1,
        activeProviderId: defaultProviderId(input.registeredProviderIds),
        warningCode: "active_provider_unavailable",
      };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        const activeProviderId = defaultProviderId(input.registeredProviderIds);
        const selection = { version: 1, activeProviderId } as const;
        await this.save(selection);
        return selection;
      }
      if (error instanceof ActiveProviderStoreError) throw error;
      throw new ActiveProviderStoreError("active_provider_read_failed");
    }
  }

  async save(provider: ActiveProvider): Promise<void> {
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      const selection = activeProviderSchema.parse(provider);
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(selection)}\n`, "utf8");
      await this.renameFile(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof ActiveProviderStoreError) throw error;
      throw new ActiveProviderStoreError("active_provider_write_failed");
    }
  }
}

function defaultProviderId(registeredProviderIds: readonly string[]): string {
  if (registeredProviderIds.includes("feishu-project")) return "feishu-project";
  const first = registeredProviderIds[0];
  if (first) return first;
  throw new ActiveProviderStoreError("active_provider_read_failed");
}

function isNodeError(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
