import { describe, expect, it, vi } from "vitest";

import type { CreatedSyncDiagnosticLogger } from "../src/observability/created-sync-diagnostic-logger.js";

const providerConstructor = vi.hoisted(() => vi.fn());

vi.mock("../src/meegle/meegle-work-item-provider.js", () => ({
  MeegleWorkItemProvider: class {
    readonly id = "feishu-project";
    readonly queryMode = "account_scoped" as const;

    constructor(options: unknown) {
      providerConstructor(options);
    }

    async listAccountWorkItems() {
      return { projects: [], scopes: [] };
    }
  },
}));

import { createDefaultRuntimeServices } from "../src/server/runtime-services.js";

describe("runtime services", () => {
  it("injects a replaceable created-sync diagnostic logger into the Meegle provider", () => {
    const logger: CreatedSyncDiagnosticLogger = { completed: vi.fn() };

    createDefaultRuntimeServices(() => new Date("2026-08-11T00:00:00Z"), {
      createdSyncDiagnosticLogger: logger,
    });

    expect(providerConstructor).toHaveBeenCalledWith(expect.objectContaining({
      diagnosticLogger: logger,
    }));
  });
});
