import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function readJson(path: string) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("FlowRivet plugin package", () => {
  it("connects the plugin manifest to its skill and local MCP server", async () => {
    const plugin = await readJson(".codex-plugin/plugin.json");
    const mcp = await readJson(".mcp.json") as {
      mcpServers: Record<string, { type: string; url: string }>;
    };
    const skill = await readFile(
      resolve(repositoryRoot, "skills/my-work-taskboard/SKILL.md"),
      "utf8",
    );

    expect(plugin.name).toBe("flowrivet");
    expect(plugin.mcpServers).toBe("./.mcp.json");
    expect(plugin.skills).toBe("./skills/");
    expect(JSON.stringify(plugin)).toContain("打开我的待办看板");
    expect(JSON.stringify(plugin)).toContain("飞书项目");
    expect(JSON.stringify(plugin)).not.toContain("拖动");
    expect(JSON.stringify(plugin)).not.toContain('"Write"');
    expect(mcp.mcpServers.flowrivet).toEqual({
      type: "http",
      url: "http://127.0.0.1:43120/mcp",
    });
    expect(skill).toContain("open_my_taskboard");
    expect(skill).toContain("refresh_my_work_items");
    expect(skill).toContain("start_provider_login");
    expect(skill).toContain("get_provider_connection");
    expect(skill).toContain("飞书项目");
    expect(skill).toContain("@lark-project/meegle");
    expect(skill).not.toMatch(/Meegle Token|飞书项目 Token/i);
    expect(skill).not.toContain("官方飞书项目 MCP 是必需");
    expect(skill).not.toContain("Phase 0");
    expect(skill).not.toContain("演示数据");
  });

  it("does not package credentials or placeholders", async () => {
    const files = await Promise.all([
      readFile(resolve(repositoryRoot, ".codex-plugin/plugin.json"), "utf8"),
      readFile(resolve(repositoryRoot, ".mcp.json"), "utf8"),
      readFile(resolve(repositoryRoot, "skills/my-work-taskboard/SKILL.md"), "utf8"),
    ]);
    const packagedText = files.join("\n");

    expect(packagedText).not.toMatch(
      /TAPD_TOKEN|TAPD_SECRET|MEEGLE_USER_ACCESS_TOKEN|client_secret|authorization:\s*bearer|\[TODO:/i,
    );
    expect(packagedText).not.toContain("吴晨杰");
    expect(packagedText).not.toContain("�");
  });

  it("publishes only runtime output and the redacted cache probe", async () => {
    const packageJson = await readJson("packages/codex-plugin/package.json");

    expect(packageJson.files).toEqual([
      "dist/",
      "scripts/probe-work-item-cache.mjs",
    ]);
  });
});
