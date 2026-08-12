import { describe, expect, it, vi } from "vitest";

import { UpdateService } from "../../packages/updater/src/update/update-service.js";

describe("internal auto-update transaction", () => {
  it("keeps the previous runtime available when candidate health fails", async () => {
    const running: string[] = ["1.0.0"];
    const failures: string[] = [];
    const service = new UpdateService({
      currentVersion: async () => "1.0.0",
      acquireLock: async () => async () => undefined,
      resolveRelease: async () => ({ version: "1.1.0" }),
      isCoolingDown: async () => false,
      stage: async () => undefined,
      stopCurrent: async () => { running.splice(0); },
      startVersion: async (version) => { if (version === "1.1.0") throw new Error("health_timeout"); running.push(version); },
      activate: vi.fn(),
      recordSuccess: vi.fn(),
      recordFailure: async (_version, code) => { failures.push(code); },
    });
    await expect(service.checkAndInstall()).rejects.toThrow("candidate_activation_failed");
    expect(running).toEqual(["1.0.0"]);
    expect(failures).toEqual(["candidate_activation_failed"]);
  });
});
