import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies } from "../src/cli.js";
import type { DoctorProbe } from "../src/doctor.js";
import { FLOWRIVET_FIELDS, type CustomField, type FieldAdmin, type FieldDefinition } from "../src/tapd/fields.js";
import { parseRequirement, type Requirement } from "../src/domain/requirement.js";
import type { PocStoryAdmin, PocStoryInput } from "../src/poc/seed.js";

const env = {
  TAPD_API_ENDPOINT: "https://api.tapd.cn",
  TAPD_TOKEN: "personal-token",
  TAPD_API_USER: "api-user",
  TAPD_API_PASSWORD: "api-password",
  TAPD_SOURCE_WORKSPACE_ID: "56536239",
  TAPD_SANDBOX_WORKSPACE_ID: "50396062",
  FLOWRIVET_POC_OWNER: "wuchenjie",
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
};

function dependencies(admin: CliFieldAdmin): CliDependencies {
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
});
