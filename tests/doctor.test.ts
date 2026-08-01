import { describe, expect, it } from "vitest";

import { runDoctor, type DoctorProbe } from "../src/doctor.js";

const config = {
  apiEndpoint: "https://api.tapd.cn",
  personalToken: "secret",
  apiUser: "admin",
  apiPassword: "secret",
  sourceWorkspaceId: "56536239",
  sandboxWorkspaceId: "50396062",
  dryRun: true,
  allowLiveWrites: false,
  feishuApiEndpoint: "https://open.feishu.cn/open-apis",
  feishuAppId: "cli_test",
  feishuAppSecret: "feishu-secret",
  feishuTestChatId: "oc_test_chat",
  feishuPocUserOpenId: "ou_test_user",
  pocTapdUser: "wuchenjie",
};

describe("runDoctor", () => {
  it("reports both authentication modes and project isolation", async () => {
    const probe: DoctorProbe = {
      checkPersonalAccess: async () => ({ ok: true, detail: "source readable" }),
      checkAdminAccess: async () => ({ ok: true, detail: "sandbox writable" }),
      checkFeishuAccess: async () => ({ ok: true, detail: "Feishu app authenticated" }),
    };

    const report = await runDoctor(config, probe);

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.code)).toEqual([
      "CONFIG_ISOLATED",
      "PERSONAL_AUTH",
      "ADMIN_AUTH",
      "FEISHU_AUTH",
    ]);
  });

  it("fails safely when the administrator account cannot access the sandbox", async () => {
    const probe: DoctorProbe = {
      checkPersonalAccess: async () => ({ ok: true, detail: "source readable" }),
      checkAdminAccess: async () => ({ ok: false, detail: "sandbox forbidden" }),
      checkFeishuAccess: async () => ({ ok: true, detail: "Feishu app authenticated" }),
    };

    const report = await runDoctor(config, probe);

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.code === "ADMIN_AUTH")).toMatchObject({
      code: "ADMIN_AUTH",
      ok: false,
    });
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});
