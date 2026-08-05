import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface ToolSnapshot {
  server: { name: string; version: string };
  transport: string;
  python: string;
  tools: Array<{ name: string; required: string[] }>;
}

async function loadSnapshot(): Promise<ToolSnapshot> {
  const url = new URL("../fixtures/tapd/official-mcp-1.29.0-tools.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as ToolSnapshot;
}

describe("TAPD official MCP capability snapshot", () => {
  it("captures the verified server and runtime prerequisites", async () => {
    const snapshot = await loadSnapshot();

    expect(snapshot.server).toEqual({ name: "mcp-tapd", version: "1.29.0" });
    expect(snapshot.transport).toBe("stdio");
    expect(snapshot.python).toBe(">=3.13");
  });

  it("contains the tools needed for user-scoped requirement workflows", async () => {
    const snapshot = await loadSnapshot();
    const names = snapshot.tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      "get_user_participant_projects",
      "get_workspace_info",
      "get_workspace_users",
      "get_entity_custom_fields",
      "get_workflows_all_transitions",
      "get_stories_or_tasks",
      "create_story_or_task",
      "create_comments",
      "update_story_or_task",
    ]));
  });

  it("does not claim unsupported project initialization tools", async () => {
    const snapshot = await loadSnapshot();
    const names = snapshot.tools.map((tool) => tool.name);

    expect(names).not.toContain("create_custom_field");
    expect(names).not.toContain("configure_gitlab_repository");
    expect(names).not.toContain("create_workflow_transition");
  });
});
