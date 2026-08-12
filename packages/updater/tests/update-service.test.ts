import { describe, expect, it, vi } from "vitest";

import { UpdateService } from "../src/update/update-service.js";

describe("UpdateService", () => {
  it("does nothing when the channel version is current", async () => {
    const dependencies = fixtureDependencies({ targetVersion: "0.1.0" });
    const result = await new UpdateService(dependencies).checkAndInstall();
    expect(result).toEqual({ outcome: "current", version: "0.1.0" });
    expect(dependencies.stage).not.toHaveBeenCalled();
  });

  it("activates a healthy candidate in transaction order", async () => {
    const events: string[] = [];
    const dependencies = fixtureDependencies({ events });
    const result = await new UpdateService(dependencies).checkAndInstall();
    expect(result).toEqual({ outcome: "updated", version: "0.2.0", previousVersion: "0.1.0" });
    expect(events).toEqual(["lock", "resolve", "stage", "stop", "start:0.2.0", "activate", "success", "unlock"]);
  });

  it("rolls back and cools down a candidate that fails health", async () => {
    const events: string[] = [];
    const dependencies = fixtureDependencies({ events, failCandidate: true });
    await expect(new UpdateService(dependencies).checkAndInstall()).rejects.toThrow("candidate_activation_failed");
    expect(events).toEqual(["lock", "resolve", "stage", "stop", "start:0.2.0", "start:0.1.0", "failure", "unlock"]);
    expect(dependencies.recordFailure).toHaveBeenCalledWith("0.2.0", "candidate_activation_failed");
  });

  it("skips a failed version while its persisted cooldown is active", async () => {
    const dependencies = fixtureDependencies({ coolingDown: true });
    const result = await new UpdateService(dependencies).checkAndInstall();
    expect(result).toEqual({ outcome: "cooldown", version: "0.2.0" });
    expect(dependencies.stage).not.toHaveBeenCalled();
  });
});

function fixtureDependencies(options: {
  events?: string[];
  targetVersion?: string;
  failCandidate?: boolean;
  coolingDown?: boolean;
} = {}) {
  const events = options.events ?? [];
  return {
    currentVersion: async () => "0.1.0",
    acquireLock: vi.fn(async () => { events.push("lock"); return async () => { events.push("unlock"); }; }),
    resolveRelease: vi.fn(async () => { events.push("resolve"); return { version: options.targetVersion ?? "0.2.0" }; }),
    isCoolingDown: vi.fn(async () => options.coolingDown ?? false),
    stage: vi.fn(async () => { events.push("stage"); }),
    stopCurrent: vi.fn(async () => { events.push("stop"); }),
    startVersion: vi.fn(async (version: string) => {
      events.push(`start:${version}`);
      if (version === "0.2.0" && options.failCandidate) throw new Error("health_timeout");
    }),
    activate: vi.fn(async () => { events.push("activate"); }),
    recordSuccess: vi.fn(async () => { events.push("success"); }),
    recordFailure: vi.fn(async () => { events.push("failure"); }),
  };
}
