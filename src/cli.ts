#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { loadConfig, type FlowRivetConfig } from "./config.js";
import { checkRequirementAdmission } from "./checks/admission.js";
import { runDoctor, type DoctorProbe } from "./doctor.js";
import { TapdClient } from "./tapd/client.js";
import { initializeFields, type FieldAdmin } from "./tapd/fields.js";
import { TapdDoctorProbe } from "./tapd/probe.js";
import { TapdReadClient, type RequirementReader } from "./tapd/read-client.js";

export interface CliDependencies {
  createDoctorProbe(config: FlowRivetConfig): DoctorProbe;
  createFieldAdmin(config: FlowRivetConfig): FieldAdmin;
  createRequirementReader(config: FlowRivetConfig): RequirementReader;
}

export interface CliResult {
  exitCode: number;
  output: string;
}

const defaultDependencies: CliDependencies = {
  createDoctorProbe: () => new TapdDoctorProbe(),
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
    output: `${message}\n\nUsage:\n  flowrivet doctor\n  flowrivet tapd init-fields [--apply]\n  flowrivet tapd check-admission <requirement-id>`,
  };
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
