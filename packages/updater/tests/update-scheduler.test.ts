import { describe, expect, it, vi } from "vitest";

import { UpdateScheduler } from "../src/update/update-scheduler.js";

describe("UpdateScheduler", () => {
  it("runs at startup, coalesces overlapping checks, and schedules the next check", async () => {
    let release!: () => void;
    const check = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const scheduled: number[] = [];
    const scheduler = new UpdateScheduler({
      check,
      installationId: "install-a",
      baseIntervalMs: 30 * 60_000,
      schedule: (callback, delay) => { scheduled.push(delay); return { callback }; },
      cancel: vi.fn(),
    });

    const first = scheduler.checkNow();
    const second = scheduler.checkNow();
    expect(check).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toBeGreaterThanOrEqual(27 * 60_000);
    expect(scheduled[0]).toBeLessThanOrEqual(33 * 60_000);
  });

  it("backs off after synchronous failures without creating a busy loop", async () => {
    const scheduled: number[] = [];
    const scheduler = new UpdateScheduler({
      check: vi.fn(() => { throw new Error("offline"); }),
      installationId: "install-b",
      baseIntervalMs: 30 * 60_000,
      schedule: (_callback, delay) => { scheduled.push(delay); return {}; },
      cancel: vi.fn(),
    });
    await scheduler.checkNow();
    await scheduler.checkNow();
    expect(scheduled[1]).toBeGreaterThan(scheduled[0]!);
  });
});
