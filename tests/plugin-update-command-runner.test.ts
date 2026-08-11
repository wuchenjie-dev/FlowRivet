import { describe, expect, it } from "vitest";

import { runCommand } from "../src/plugin-update/command-runner.js";

describe("runCommand", () => {
  it("captures stdout and stderr without a shell", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err')",
    ]);

    expect(result).toEqual({ exitCode: 0, stdout: "out", stderr: "err" });
  });

  it("terminates commands that exceed the timeout", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: "command_timeout" });
  });
});
