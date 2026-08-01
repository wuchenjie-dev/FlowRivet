#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { loadConfig, type FlowRivetConfig } from "./config.js";
import { checkRequirementAdmission } from "./checks/admission.js";
import { runDoctor, type DoctorProbe } from "./doctor.js";
import { TapdClient } from "./tapd/client.js";
import { POC_REQUIREMENTS, seedPocRequirements, type PocStoryAdmin } from "./poc/seed.js";
import { initializeFields, type FieldAdmin } from "./tapd/fields.js";
import { TapdDoctorProbe } from "./tapd/probe.js";
import { TapdReadClient, type RequirementReader } from "./tapd/read-client.js";
import {
  FeishuClient,
  type FeishuMessagingProbe,
  type FeishuNotifier,
} from "./feishu/client.js";
import { verifyIdentityBinding } from "./identity/binding.js";
import { buildAdmissionReminder } from "./reminders/admission.js";
import {
  recordAdmissionReminder,
  type RequirementCommentAdmin,
} from "./tapd/reminder-record.js";

export interface CliDependencies {
  createDoctorProbe(config: FlowRivetConfig): DoctorProbe;
  createFieldAdmin(config: FlowRivetConfig): FieldAdmin;
  createPocStoryAdmin(config: FlowRivetConfig): PocStoryAdmin;
  createRequirementReader(config: FlowRivetConfig): RequirementReader;
  createSandboxRequirementReader(config: FlowRivetConfig): RequirementReader;
  createFeishuMessagingProbe(config: FlowRivetConfig): FeishuMessagingProbe;
  createFeishuNotifier(config: FlowRivetConfig): FeishuNotifier;
  createRequirementCommentAdmin(config: FlowRivetConfig): RequirementCommentAdmin;
}

export interface CliResult {
  exitCode: number;
  output: string;
}

const defaultDependencies: CliDependencies = {
  createDoctorProbe: (config) => {
    const tapd = new TapdDoctorProbe();
    const feishu = new FeishuClient({
      endpoint: config.feishuApiEndpoint,
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
    });
    return {
      checkPersonalAccess: (current) => tapd.checkPersonalAccess(current),
      checkAdminAccess: (current) => tapd.checkAdminAccess(current),
      checkFeishuAccess: () => feishu.checkAccess(),
    };
  },
  createFieldAdmin: (config) =>
    TapdClient.forAdmin({
      endpoint: config.apiEndpoint,
      workspaceId: config.sandboxWorkspaceId,
      apiUser: config.apiUser,
      apiPassword: config.apiPassword,
    }),
  createRequirementReader: (config) =>
    new TapdReadClient({
      endpoint: config.apiEndpoint,
      workspaceId: config.sourceWorkspaceId,
      personalToken: config.personalToken,
    }),
  createPocStoryAdmin: (config) =>
    TapdClient.forAdmin({
      endpoint: config.apiEndpoint,
      workspaceId: config.sandboxWorkspaceId,
      apiUser: config.apiUser,
      apiPassword: config.apiPassword,
    }),
  createSandboxRequirementReader: (config) =>
    TapdClient.forAdmin({
      endpoint: config.apiEndpoint,
      workspaceId: config.sandboxWorkspaceId,
      apiUser: config.apiUser,
      apiPassword: config.apiPassword,
    }),
  createFeishuMessagingProbe: (config) =>
    new FeishuClient({
      endpoint: config.feishuApiEndpoint,
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
    }),
  createFeishuNotifier: (config) =>
    new FeishuClient({
      endpoint: config.feishuApiEndpoint,
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
    }),
  createRequirementCommentAdmin: (config) =>
    TapdClient.forAdmin({
      endpoint: config.apiEndpoint,
      workspaceId: config.sandboxWorkspaceId,
      apiUser: config.apiUser,
      apiPassword: config.apiPassword,
    }),
};

export async function runCli(
  args: string[],
  environment: Record<string, string | undefined> = process.env,
  dependencies: CliDependencies = defaultDependencies,
): Promise<CliResult> {
  try {
    if (args[0] === "doctor" && args.length === 1) {
      const config = loadConfig(environment);
      const report = await runDoctor(config, dependencies.createDoctorProbe(config));
      return { exitCode: report.ok ? 0 : 1, output: JSON.stringify(report, null, 2) };
    }

    if (args[0] === "tapd" && args[1] === "init-fields") {
      const unsupported = args.slice(2).filter((arg) => arg !== "--apply");
      if (unsupported.length > 0) return usage(`Unknown option: ${unsupported[0]}`);

      const config = loadConfig(environment);
      const dryRun = !args.includes("--apply");
      const result = await initializeFields(dependencies.createFieldAdmin(config), { dryRun });
      return {
        exitCode: 0,
        output: JSON.stringify({ dryRun, workspaceId: config.sandboxWorkspaceId, ...result }, null, 2),
      };
    }

    if (args[0] === "tapd" && args[1] === "check-admission" && args.length === 3) {
      const config = loadConfig(environment);
      const requirement = await dependencies
        .createRequirementReader(config)
        .getRequirement(args[2] ?? "");
      const result = checkRequirementAdmission(requirement);
      return {
        exitCode: result.passed ? 0 : 3,
        output: JSON.stringify({ requirementId: requirement.id, ...result }, null, 2),
      };
    }

    if (args[0] === "tapd" && args[1] === "seed-poc") {
      const unsupported = args.slice(2).filter((arg) => arg !== "--apply");
      if (unsupported.length > 0) return usage(`Unknown option: ${unsupported[0]}`);
      const config = loadConfig(environment);
      if (!config.pocOwner) throw new Error("FLOWRIVET_POC_OWNER is required for seed-poc");
      const dryRun = !args.includes("--apply");
      const result = await seedPocRequirements(dependencies.createPocStoryAdmin(config), {
        dryRun,
        owner: config.pocOwner,
      });
      return {
        exitCode: 0,
        output: JSON.stringify({ dryRun, workspaceId: config.sandboxWorkspaceId, ...result }, null, 2),
      };
    }

    if (args[0] === "tapd" && args[1] === "verify-poc" && args.length === 2) {
      const config = loadConfig(environment);
      const admin = dependencies.createPocStoryAdmin(config);
      const reader = dependencies.createSandboxRequirementReader(config);
      const requirements = [];
      for (const definition of POC_REQUIREMENTS) {
        const story = await admin.findStoryByExactTitle(definition.title);
        if (!story) throw new Error(`POC requirement not found: ${definition.title}`);
        const requirement = await reader.getRequirement(story.id);
        requirements.push({
          id: requirement.id,
          title: requirement.title,
          admission: checkRequirementAdmission(requirement),
        });
      }
      const passed = requirements.every((item) => item.admission.passed);
      return {
        exitCode: passed ? 0 : 3,
        output: JSON.stringify({ workspaceId: config.sandboxWorkspaceId, passed, requirements }, null, 2),
      };
    }

    if (args[0] === "tapd" && args[1] === "record-blocker-reminder") {
      const unsupported = args.slice(2).filter((arg) => arg !== "--apply");
      if (unsupported.length > 0) return usage(`Unknown option: ${unsupported[0]}`);
      const config = loadConfig(environment);
      const plan = await loadBlockedPocReminder(config, dependencies);
      const result = await recordAdmissionReminder(
        dependencies.createRequirementCommentAdmin(config),
        plan,
        { dryRun: !args.includes("--apply"), author: config.pocTapdUser },
      );
      return {
        exitCode: 0,
        output: JSON.stringify({
          ...result,
          requirementId: plan.requirementId,
          findingCodes: plan.findings.map((finding) => finding.code),
        }, null, 2),
      };
    }

    if (args[0] === "feishu" && args[1] === "check-messaging" && args.length === 2) {
      const config = loadConfig(environment);
      const result = await dependencies
        .createFeishuMessagingProbe(config)
        .checkMessagingAccess();
      return {
        exitCode: result.ok ? 0 : 4,
        output: JSON.stringify(result, null, 2),
      };
    }

    if (args[0] === "feishu" && args[1] === "send-poc-card") {
      const unsupported = args.slice(2).filter((arg) => arg !== "--apply");
      if (unsupported.length > 0) return usage(`Unknown option: ${unsupported[0]}`);
      const config = loadConfig(environment);
      const result = await dependencies.createFeishuNotifier(config).sendPocCard({
        dryRun: !args.includes("--apply"),
        chatId: config.feishuTestChatId,
      });
      return { exitCode: 0, output: JSON.stringify(result, null, 2) };
    }

    if (args[0] === "feishu" && args[1] === "verify-identity" && args.length === 2) {
      const config = loadConfig(environment);
      const result = verifyIdentityBinding({
        tapdUser: config.pocTapdUser,
        feishuOpenId: config.feishuPocUserOpenId,
      });
      return { exitCode: 0, output: JSON.stringify(result, null, 2) };
    }

    if (
      args[0] === "feishu" &&
      args[1] === "preview-blocker-reminder" &&
      args.length === 2
    ) {
      const config = loadConfig(environment);
      const plan = await loadBlockedPocReminder(config, dependencies);
      return {
        exitCode: 0,
        output: JSON.stringify(
          {
            dryRun: true,
            requirementId: plan.requirementId,
            title: plan.title,
            recipientBound: true,
            findingCount: plan.findings.length,
            findingCodes: plan.findings.map((finding) => finding.code),
          },
          null,
          2,
        ),
      };
    }

    if (args[0] === "feishu" && args[1] === "send-blocker-reminder") {
      const unsupported = args.slice(2).filter((arg) => arg !== "--apply");
      if (unsupported.length > 0) return usage(`Unknown option: ${unsupported[0]}`);
      const config = loadConfig(environment);
      const plan = await loadBlockedPocReminder(config, dependencies);
      const result = await dependencies.createFeishuNotifier(config).sendAdmissionReminder({
        dryRun: !args.includes("--apply"),
        chatId: config.feishuTestChatId,
        reminder: plan,
      });
      return {
        exitCode: 0,
        output: JSON.stringify({
          ...result,
          requirementId: plan.requirementId,
          title: plan.title,
          recipientBound: true,
          findingCount: plan.findings.length,
          findingCodes: plan.findings.map((finding) => finding.code),
        }, null, 2),
      };
    }

    return usage("Unknown command");
  } catch (error) {
    return {
      exitCode: 1,
      output: JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
}

function usage(message: string): CliResult {
  return {
    exitCode: 2,
    output: `${message}\n\nUsage:\n  flowrivet doctor\n  flowrivet tapd init-fields [--apply]\n  flowrivet tapd check-admission <requirement-id>\n  flowrivet tapd seed-poc [--apply]\n  flowrivet tapd verify-poc\n  flowrivet tapd record-blocker-reminder [--apply]\n  flowrivet feishu check-messaging\n  flowrivet feishu send-poc-card [--apply]\n  flowrivet feishu verify-identity\n  flowrivet feishu preview-blocker-reminder\n  flowrivet feishu send-blocker-reminder [--apply]`,
  };
}

async function loadBlockedPocReminder(
  config: FlowRivetConfig,
  dependencies: CliDependencies,
) {
  const definition = POC_REQUIREMENTS.find((item) => item.title.includes("跨模块"));
  if (!definition) throw new Error("Blocked POC requirement definition not found");
  const story = await dependencies
    .createPocStoryAdmin(config)
    .findStoryByExactTitle(definition.title);
  if (!story) throw new Error(`POC requirement not found: ${definition.title}`);
  const requirement = await dependencies
    .createSandboxRequirementReader(config)
    .getRequirement(story.id);
  return buildAdmissionReminder({
    requirement,
    admission: checkRequirementAdmission(requirement),
    binding: {
      tapdUser: config.pocTapdUser,
      feishuOpenId: config.feishuPocUserOpenId,
    },
  });
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
