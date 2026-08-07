import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("Codex taskboard demo operations guide", () => {
  it("documents the full local registration and verification path", async () => {
    const guide = await readFile(
      resolve(repositoryRoot, "docs/operations/codex-plugin-demo.md"),
      "utf8",
    );

    expect(guide).toContain("Node.js 22");
    expect(guide).toContain("npm start --workspace @flowrivet/codex-plugin");
    expect(guide).toContain("http://127.0.0.1:43120/health");
    expect(guide).toContain("codex plugin marketplace add");
    expect(guide).toContain(".plugin-appserver\\codex.exe");
    expect(guide).toContain("plugin add flowrivet@flowrivet-local");
    expect(guide).toContain("打开我的 TAPD 待办看板");
    expect(guide).toContain("Demo 数据");
    expect(guide).not.toMatch(/TAPD_TOKEN|TAPD_SECRET|client_secret/i);
  });

  it("links the guide and design from the README", async () => {
    const readme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");

    expect(readme).toContain("docs/operations/codex-plugin-demo.md");
    expect(readme).toContain("2026-08-06-tapd-my-work-taskboard-design.md");
  });
});
