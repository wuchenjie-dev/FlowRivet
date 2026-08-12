import { describe, expect, it } from "vitest";

import {
  gitLabConnectionSchema,
  gitLabProjectPageSchema,
} from "../src/contracts/gitlab.js";

describe("GitLab public contracts", () => {
  it("accepts a connected account without exposing credentials", () => {
    const parsed = gitLabConnectionSchema.parse({
      host: "gitlab-aiabu.ruijie.com.cn",
      state: "connected",
      accountDisplayName: "wuchenjie",
      cliVersion: "1.113.0",
    });

    expect(parsed.state).toBe("connected");
    expect(JSON.stringify(parsed)).not.toMatch(/token|secret/i);
  });

  it("rejects credential-bearing project clone URLs", () => {
    expect(() => gitLabProjectPageSchema.parse({
      page: 1,
      hasMore: false,
      projects: [{
        host: "gitlab-aiabu.ruijie.com.cn",
        projectId: "75",
        pathWithNamespace: "cc/flowrivet",
        displayName: "FlowRivet",
        defaultBranch: "main",
        httpUrl: "https://oauth2:secret@gitlab-aiabu.ruijie.com.cn/cc/flowrivet.git",
      }],
    })).toThrow();
  });
});
