import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies } from "../src/cli.js";
import type { DoctorProbe } from "../src/doctor.js";
import type { CustomField, FieldAdmin, FieldDefinition } from "../src/tapd/fields.js";
import { parseRequirement, type Requirement } from "../src/domain/requirement.js";

const env = {
  TAPD_API_ENDPOINT: "https://api.tapd.cn",
  TAPD_TOKEN: "personal-token",
  TAPD_API_USER: "api-user",
  TAPD_API_PASSWORD: "api-password",
  TAPD_SOURCE_WORKSPACE_ID: "56536239",
  TAPD_SANDBOX_WORKSPACE_ID: "50396062",
};

class CliFieldAdmin implements FieldAdmin {
  readonly created: FieldDefinition[] = [];

  async listCustomFields(): Promise<CustomField[]> {
    return [];
  }

  async createCustomField(field: FieldDefinition): Promise<CustomField> {
    this.created.push(field);
    return {
      name: field.name,
      type: field.type,
      options: field.options ? [...field.options] : [],
      field: `custom_field_${this.created.length}`,
      enabled: true,
    };
  }
}

const passingProbe: DoctorProbe = {
  checkPersonalAccess: async () => ({ ok: true, detail: "source readable" }),
  checkAdminAccess: async () => ({ ok: true, detail: "sandbox writable" }),
};

function dependencies(admin: FieldAdmin): CliDependencies {
  return {
    createDoctorProbe: () => passingProbe,
    createFieldAdmin: () => admin,
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
    expect(admin.created).toEqual([]);
  });

  it("writes fields only with the apply flag", async () => {
    const admin = new CliFieldAdmin();

    const result = await runCli(
      ["tapd", "init-fields", "--apply"],
      env,
      dependencies(admin),
    );

    expect(result.exitCode).toBe(0);
    expect(admin.created).toHaveLength(14);
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
});
