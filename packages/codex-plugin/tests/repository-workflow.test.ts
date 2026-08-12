import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { RepositoryWorkflow } from "../src/gitlab/repository-workflow.js";

describe("RepositoryWorkflow", () => {
  it("reuses only an exact clean local repository", async () => {
    const inspect = vi.fn().mockResolvedValue({ originProjectPath: "cc/flowrivet", clean: true });
    const workflow = new RepositoryWorkflow({ git: { inspect, clone: vi.fn() } });
    await expect(workflow.prepare({ project: project(), localPath: "C:\\work\\flowrivet" }))
      .resolves.toMatchObject({ localPath: "C:\\work\\flowrivet", reused: true });
  });

  it("rejects a non-empty clone target and path escape", async () => {
    const parent = mkdtempSync(join(tmpdir(), "flowrivet-parent-"));
    const occupied = join(parent, "flowrivet");
    mkdirSync(occupied); writeFileSync(join(occupied, "keep.txt"), "user data");
    const workflow = new RepositoryWorkflow({ git: { inspect: vi.fn(), clone: vi.fn() } });
    await expect(workflow.prepare({ project: project(), parentDirectory: parent }))
      .rejects.toThrow("repository_target_not_empty");
    await expect(workflow.prepare({ project: { ...project(), pathWithNamespace: "cc/.." }, parentDirectory: parent }))
      .rejects.toThrow("repository_target_invalid");
  });
});

function project() { return {
  host: "gitlab-aiabu.ruijie.com.cn", projectId: "1", pathWithNamespace: "cc/flowrivet",
  displayName: "FlowRivet", defaultBranch: "main",
  httpUrl: "https://gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git",
}; }
