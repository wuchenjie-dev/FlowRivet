import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnv = {
  TAPD_API_ENDPOINT: "https://api.tapd.cn",
  TAPD_TOKEN: "personal-token",
  TAPD_API_USER: "api-user",
  TAPD_API_PASSWORD: "api-password",
  TAPD_SOURCE_WORKSPACE_ID: "56536239",
  TAPD_SANDBOX_WORKSPACE_ID: "50396062",
  FEISHU_API_ENDPOINT: "https://open.feishu.cn/open-apis",
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "feishu-secret",
  FEISHU_TEST_CHAT_ID: "oc_test_chat",
};

describe("loadConfig", () => {
  it("loads isolated source and sandbox projects with dry-run enabled", () => {
    const config = loadConfig(validEnv);

    expect(config.sourceWorkspaceId).toBe("56536239");
    expect(config.sandboxWorkspaceId).toBe("50396062");
    expect(config.dryRun).toBe(true);
  });

  it("rejects missing administrator credentials", () => {
    expect(() => loadConfig({ ...validEnv, TAPD_API_PASSWORD: undefined })).toThrow(
      /TAPD_API_PASSWORD/,
    );
  });

  it("rejects missing Feishu application credentials", () => {
    expect(() => loadConfig({ ...validEnv, FEISHU_APP_SECRET: undefined })).toThrow(
      /FEISHU_APP_SECRET/,
    );
  });

  it("rejects identical source and sandbox projects by default", () => {
    expect(() =>
      loadConfig({ ...validEnv, TAPD_SANDBOX_WORKSPACE_ID: "56536239" }),
    ).toThrow(/must be different/);
  });

  it("allows an explicit live mode override", () => {
    const config = loadConfig({
      ...validEnv,
      TAPD_SANDBOX_WORKSPACE_ID: "56536239",
      FLOWRIVET_ALLOW_LIVE_WRITES: "true",
    });

    expect(config.allowLiveWrites).toBe(true);
  });
});
