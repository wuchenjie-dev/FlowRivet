import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";

describe("updater CLI", () => {
  it("supports check and status JSON output with stable exit codes", async () => {
    const output: string[] = [];
    const dependencies = {
      check: vi.fn(async () => ({ outcome: "current", version: "0.1.0" })),
      status: vi.fn(async () => ({ running: true, version: "0.1.0" })),
      configure: vi.fn(),
      run: vi.fn(),
      uninstallStartup: vi.fn(),
      write: (line: string) => output.push(line),
    };
    await expect(runCli(["check", "--json"], dependencies)).resolves.toBe(0);
    await expect(runCli(["status", "--json"], dependencies)).resolves.toBe(0);
    expect(output.map((line) => JSON.parse(line))).toEqual([
      { outcome: "current", version: "0.1.0" },
      { running: true, version: "0.1.0" },
    ]);
  });

  it("rejects unknown commands without echoing arguments", async () => {
    const output: string[] = [];
    const dependencies = {
      check: vi.fn(), status: vi.fn(), configure: vi.fn(), run: vi.fn(), uninstallStartup: vi.fn(),
      write: (line: string) => output.push(line),
    };
    await expect(runCli(["unknown", "secret-token"], dependencies)).resolves.toBe(2);
    expect(output.join(" ")).toBe("unknown_command");
  });
});
