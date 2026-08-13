import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

import { probeCodexTaskBridge } from "../scripts/probe-codex-task-bridge.mjs";
import { probeGlabContract } from "../scripts/probe-glab-contract.mjs";
import { parseProbeArgs } from "../../../scripts/probe-meegle-write-contract.mjs";
import { isMain } from "../scripts/probe-runtime.mjs";

describe("integration capability probes", () => {
  it("recognizes a Windows entry script as the main module", () => {
    const entryUrl = new URL("../scripts/probe-glab-contract.mjs", import.meta.url);
    const entryPath = fileURLToPath(entryUrl);
    expect(isMain(entryUrl.href, entryPath)).toBe(true);
  });

  it("reports a missing glab CLI without leaking command output", async () => {
    const result = await probeGlabContract({
      resolveCommand: vi.fn().mockResolvedValue(undefined),
      runCommand: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      capability: "gitlab",
      errorCode: "gitlab_cli_missing",
    });
    expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token|glpat-/i);
  });

  it("returns only the allowlisted glab capability summary", async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "glab 1.68.0 (abcdef)",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "authenticated as secret-user with glpat-secret",
        stderr: "refresh_token=secret",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{ id: 75, path_with_namespace: "cc/flowrivet" }]),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{ iid: 3, title: "private title" }]),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{ id: 9, status: "success" }]),
        stderr: "",
      });

    const result = await probeGlabContract({
      resolveCommand: vi.fn().mockResolvedValue("C:\\tools\\glab.exe"),
      runCommand,
    });

    expect(result).toEqual({
      ok: true,
      capability: "gitlab",
      version: "1.68.0",
      auth: true,
      projects: true,
      mergeRequests: true,
      pipelines: true,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret-user|private title|access_token|refresh_token|glpat-/i,
    );
  });

  it("falls back to a recoverable handoff when direct Codex task APIs are absent", async () => {
    await expect(probeCodexTaskBridge({ hostCapabilities: {} })).resolves.toEqual({
      ok: true,
      capability: "codex_task_bridge",
      mode: "handoff",
    });
  });

  it("does not start the Meegle write probe without an isolated fixture", () => {
    expect(() => parseProbeArgs([])).toThrow("isolated_fixture_required");
  });
});
