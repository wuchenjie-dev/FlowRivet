import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies } from "../src/cli.js";
import type { DoctorProbe } from "../src/doctor.js";
import { FLOWRIVET_FIELDS, type CustomField, type FieldAdmin, type FieldDefinition } from "../src/tapd/fields.js";
import { parseRequirement, type Requirement } from "../src/domain/requirement.js";
import type { PocStoryAdmin, PocStoryInput } from "../src/poc/seed.js";
import type { RequirementCommentAdmin } from "../src/tapd/reminder-record.js";

const env = {
  TAPD_API_ENDPOINT: "https://api.tapd.cn",
  TAPD_TOKEN: "personal-token",
  TAPD_API_USER: "api-user",
  TAPD_API_PASSWORD: "api-password",
  TAPD_SOURCE_WORKSPACE_ID: "56536239",
  TAPD_SANDBOX_WORKSPACE_ID: "50396062",
  FLOWRIVET_POC_OWNER: "wuchenjie",
  FEISHU_API_ENDPOINT: "https://open.feishu.cn/open-apis",
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "feishu-secret",
  FEISHU_TEST_CHAT_ID: "oc_test_chat",
  FEISHU_POC_USER_OPEN_ID: "ou_test_user",
  FLOWRIVET_POC_TAPD_USER: "wuchenjie",
};

class CliFieldAdmin implements FieldAdmin, PocStoryAdmin {
  readonly createdFields: FieldDefinition[] = [];
  readonly createdStories: PocStoryInput[] = [];

  async listCustomFields(): Promise<CustomField[]> {
    return [];
  }

  async createCustomField(field: FieldDefinition): Promise<CustomField> {
    this.createdFields.push(field);
    return {
      name: field.name,
      type: field.type,
      options: field.options ? [...field.options] : [],
      field: `custom_field_${this.createdFields.length}`,
      enabled: true,
    };
  }

  async findStoryByExactTitle(_title: string): Promise<{ id: string } | undefined> {
    return undefined;
  }

  async createStory(input: PocStoryInput): Promise<{ id: string }> {
    this.createdStories.push(input);
    return { id: `story-${this.createdStories.length}` };
  }
}

const passingProbe: DoctorProbe = {
  checkPersonalAccess: async () => ({ ok: true, detail: "source readable" }),
  checkAdminAccess: async () => ({ ok: true, detail: "sandbox writable" }),
  checkFeishuAccess: async () => ({ ok: true, detail: "Feishu app authenticated" }),
};

function dependencies(admin: CliFieldAdmin): CliDependencies {
  const commentAdmin: RequirementCommentAdmin = {
    listRequirementComments: async () => [],
    addRequirementComment: async () => undefined,
  };
  return {
    createDoctorProbe: () => passingProbe,
    createFieldAdmin: () => admin,
    createPocStoryAdmin: () => ({
      listCustomFields: async () =>
        FLOWRIVET_FIELDS.map((field, index) => ({
          name: field.name,
          type: field.type,
          options: field.options ? [...field.options] : [],
          field: index < 8 ? `custom_field_${["one", "two", "three", "four", "five", "six", "seven", "eight"][index]}` : `custom_field_${index + 1}`,
          enabled: true,
        })),
      findStoryByExactTitle: (title) => admin.findStoryByExactTitle(title),
      createStory: (input) => admin.createStory(input),
    }),
    createRequirementReader: () => ({
      getRequirement: async (): Promise<Requirement> =>
        parseRequirement({
          id: "42",
          workspaceId: "56536239",
          title: "ABF 测试需求",
          status: "待准入",
          sourceType: "技术",
          evidenceLinks: ["https://example.test/evidence/42"],
          targetUsers: "平台管理员",
          scenario: "维护规则",
          problem: "发布成本高",
          goal: "降低发布成本",
          successMetrics: "成功率达到 99%",
          scope: "规则配置",
          outOfScope: "自动生成全部规则",
          owners: { product: "p", development: "d", test: "t" },
          blockerQuestions: [],
        }),
    }),
    createSandboxRequirementReader: () => ({
      getRequirement: async (id): Promise<Requirement> =>
        parseRequirement({
          id,
          workspaceId: "50396062",
          title: "[FLOWRIVET_POC] 测试需求",
          status: "规划中",
          sourceType: "技术",
          evidenceLinks: ["https://example.test/evidence/poc"],
          targetUsers: "研发人员",
          scenario: "验证流程",
          problem: "缺少闭环",
          goal: "建立闭环",
          successMetrics: "准入检查通过",
          scope: "沙箱",
          outOfScope: "生产项目",
          owners: { product: "wuchenjie", development: "wuchenjie", test: "wuchenjie" },
          blockerQuestions: [],
        }),
    }),
    createFeishuMessagingProbe: () => ({
      checkMessagingAccess: async () => ({
        ok: true,
        detail: "Feishu bot can access 1 chat(s)",
      }),
    }),
    createFeishuNotifier: () => ({
      sendPocCard: async ({ dryRun }) => ({
        dryRun,
        detail: dryRun ? "POC card ready for configured test chat" : "POC card sent",
      }),
      sendAdmissionReminder: async ({ dryRun }) => ({
        dryRun,
        detail: dryRun
          ? "Blocker reminder ready for configured test chat"
          : "Blocker reminder sent",
      }),
    }),
    createRequirementCommentAdmin: () => commentAdmin,
  };
}

describe("runCli", () => {
  it("runs doctor without exposing credentials", async () => {
    const result = await runCli(["doctor"], env, dependencies(new CliFieldAdmin()));

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("PERSONAL_AUTH");
    expect(result.output).not.toContain("personal-token");
    expect(result.output).not.toContain("api-password");
  });

  it("previews field initialization by default", async () => {
    const admin = new CliFieldAdmin();

    const result = await runCli(["tapd", "init-fields"], env, dependencies(admin));

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"dryRun": true');
    expect(admin.createdFields).toEqual([]);
  });

  it("writes fields only with the apply flag", async () => {
    const admin = new CliFieldAdmin();

    const result = await runCli(
      ["tapd", "init-fields", "--apply"],
      env,
      dependencies(admin),
    );

    expect(result.exitCode).toBe(0);
    expect(admin.createdFields).toHaveLength(14);
  });

  it("returns usage for unknown commands", async () => {
    const result = await runCli(["unknown"], env, dependencies(new CliFieldAdmin()));

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("Usage:");
  });

  it("checks one TAPD requirement admission without writing", async () => {
    const result = await runCli(
      ["tapd", "check-admission", "42"],
      env,
      dependencies(new CliFieldAdmin()),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"passed": true');
    expect(result.output).toContain('"requirementId": "42"');
  });

  it("previews PoC story seeding by default", async () => {
    const admin = new CliFieldAdmin();

    const result = await runCli(["tapd", "seed-poc"], env, dependencies(admin));

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"dryRun": true');
    expect(admin.createdStories).toEqual([]);
  });

  it("creates PoC stories only with the apply flag", async () => {
    const admin = new CliFieldAdmin();

    const result = await runCli(
      ["tapd", "seed-poc", "--apply"],
      env,
      dependencies(admin),
    );

    expect(result.exitCode).toBe(0);
    expect(admin.createdStories).toHaveLength(3);
  });

  it("refuses to seed without an explicit PoC owner", async () => {
    const result = await runCli(
      ["tapd", "seed-poc"],
      { ...env, FLOWRIVET_POC_OWNER: undefined },
      dependencies(new CliFieldAdmin()),
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FLOWRIVET_POC_OWNER");
  });

  it("verifies all seeded PoC requirements from the sandbox", async () => {
    const admin = new CliFieldAdmin();
    let nextId = 17;
    admin.findStoryByExactTitle = async () => ({ id: String(nextId++) });

    const result = await runCli(["tapd", "verify-poc"], env, dependencies(admin));

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.output) as { requirements: unknown[] };
    expect(output.requirements).toHaveLength(3);
  });

  it("checks Feishu messaging access without sending messages", async () => {
    const result = await runCli(
      ["feishu", "check-messaging"],
      env,
      dependencies(new CliFieldAdmin()),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Feishu bot can access 1 chat(s)");
  });

  it("previews the Feishu POC card by default", async () => {
    const result = await runCli(
      ["feishu", "send-poc-card"],
      env,
      dependencies(new CliFieldAdmin()),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"dryRun": true');
    expect(result.output).not.toContain("oc_test_chat");
  });

  it("verifies an explicit TAPD to Feishu identity binding", async () => {
    const result = await runCli(
      ["feishu", "verify-identity"],
      env,
      dependencies(new CliFieldAdmin()),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"ok": true');
    expect(result.output).not.toContain("ou_test_user");
  });

  it("previews a blocker reminder without exposing the Feishu Open ID", async () => {
    const deps = dependencies(new CliFieldAdmin());
    deps.createPocStoryAdmin = () => ({
      listCustomFields: async () => [],
      findStoryByExactTitle: async () => ({ id: "1150396062001000019" }),
      createStory: async () => ({ id: "unused" }),
    });
    deps.createSandboxRequirementReader = () => ({
      getRequirement: async () =>
        parseRequirement({
          id: "1150396062001000019",
          workspaceId: "50396062",
          title: "[FLOWRIVET_POC] 跨模块：ABF 检测结果闭环",
          status: "规划中",
          sourceType: "产品规划",
          evidenceLinks: ["https://example.test/plan/poc-cross-1"],
          targetUsers: "产品、研发和测试人员",
          scenario: "跨模块协作",
          problem: "缺少闭环",
          goal: "建立闭环",
          successMetrics: "",
          scope: "TAPD 与飞书",
          outOfScope: "自动审批",
          owners: {
            product: "wuchenjie",
            development: "wuchenjie",
            test: "wuchenjie",
          },
          blockerQuestions: ["确认身份映射"],
        }),
    });

    const result = await runCli(["feishu", "preview-blocker-reminder"], env, deps);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"findingCount": 2');
    expect(result.output).not.toContain("ou_test_user");
  });

  it("sends a blocker reminder only with the apply flag", async () => {
    const deps = dependencies(new CliFieldAdmin());
    let applied: boolean | undefined;
    deps.createFeishuNotifier = () => ({
      sendPocCard: async () => ({ dryRun: true, detail: "unused" }),
      sendAdmissionReminder: async ({ dryRun }) => {
        applied = !dryRun;
        return { dryRun, detail: dryRun ? "ready" : "sent" };
      },
    });
    deps.createPocStoryAdmin = () => ({
      listCustomFields: async () => [],
      findStoryByExactTitle: async () => ({ id: "1150396062001000019" }),
      createStory: async () => ({ id: "unused" }),
    });
    deps.createSandboxRequirementReader = () => ({
      getRequirement: async () =>
        parseRequirement({
          id: "1150396062001000019",
          workspaceId: "50396062",
          title: "[FLOWRIVET_POC] 跨模块：ABF 检测结果闭环",
          status: "规划中",
          sourceType: "产品规划",
          evidenceLinks: ["https://example.test/plan/poc-cross-1"],
          targetUsers: "产品、研发和测试人员",
          scenario: "跨模块协作",
          problem: "缺少闭环",
          goal: "建立闭环",
          successMetrics: "",
          scope: "TAPD 与飞书",
          outOfScope: "自动审批",
          owners: { product: "wuchenjie", development: "wuchenjie", test: "wuchenjie" },
          blockerQuestions: ["确认身份映射"],
        }),
    });

    const preview = await runCli(["feishu", "send-blocker-reminder"], env, deps);
    expect(preview.exitCode).toBe(0);
    expect(applied).toBe(false);
    expect(preview.output).not.toContain("ou_test_user");

    const sent = await runCli(
      ["feishu", "send-blocker-reminder", "--apply"],
      env,
      deps,
    );
    expect(sent.exitCode).toBe(0);
    expect(applied).toBe(true);
    expect(sent.output).toContain('"dryRun": false');
  });

  it("records the blocker reminder in TAPD only with the apply flag", async () => {
    const deps = dependencies(new CliFieldAdmin());
    const comments: string[] = [];
    deps.createRequirementCommentAdmin = () => ({
      listRequirementComments: async () => comments,
      addRequirementComment: async ({ description }) => {
        comments.push(description);
      },
    });
    deps.createPocStoryAdmin = () => ({
      listCustomFields: async () => [],
      findStoryByExactTitle: async () => ({ id: "1150396062001000019" }),
      createStory: async () => ({ id: "unused" }),
    });
    deps.createSandboxRequirementReader = () => ({
      getRequirement: async () =>
        parseRequirement({
          id: "1150396062001000019",
          workspaceId: "50396062",
          title: "[FLOWRIVET_POC] 跨模块：ABF 检测结果闭环",
          status: "规划中",
          sourceType: "产品规划",
          evidenceLinks: ["https://example.test/plan/poc-cross-1"],
          targetUsers: "产品、研发和测试人员",
          scenario: "跨模块协作",
          problem: "缺少闭环",
          goal: "建立闭环",
          successMetrics: "",
          scope: "TAPD 与飞书",
          outOfScope: "自动审批",
          owners: { product: "wuchenjie", development: "wuchenjie", test: "wuchenjie" },
          blockerQuestions: ["确认身份映射"],
        }),
    });

    const preview = await runCli(["tapd", "record-blocker-reminder"], env, deps);
    expect(preview.exitCode).toBe(0);
    expect(comments).toHaveLength(0);

    const applied = await runCli(
      ["tapd", "record-blocker-reminder", "--apply"],
      env,
      deps,
    );
    expect(applied.exitCode).toBe(0);
    expect(comments).toHaveLength(1);
    expect(applied.output).toContain('"created": true');
    expect(applied.output).not.toContain("ou_test_user");
  });
});
