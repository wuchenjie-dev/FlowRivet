import { describe, expect, it, vi } from "vitest";

import { TapdTraceClient } from "../src/tapd/trace-client.js";

describe("TapdTraceClient", () => {
  it("reads Git commit relations from the TAPD project configuration", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      status: 1,
      info: "success",
      data: [{
        commit_id: "abc123",
        web_url: "http://gitlab.internal/team/abf",
        ref: "refs/heads/feature/abf",
        git_env: "gitlab",
      }],
    }));
    const client = new TapdTraceClient({
      endpoint: "https://api.tapd.cn",
      workspaceId: "56536239",
      personalToken: "personal-secret",
      fetcher,
    });

    const commits = await client.getRequirementCommits("story-1");

    expect(commits).toEqual([{
      commitId: "abc123",
      repositoryUrl: "http://gitlab.internal/team/abf",
      ref: "refs/heads/feature/abf",
      scmType: "gitlab",
    }]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("type=story");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("object_id=story-1");
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer personal-secret");
  });
});
