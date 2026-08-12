import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { argumentValue, runCli } from "./cli.js";
import { JsonUpdateConfigStore } from "./config/update-config-store.js";
import { createCredentialStore } from "./credentials/index.js";
import { resolveUpdatePaths } from "./storage/update-paths.js";
import { VersionStore } from "./storage/version-store.js";
import { UpdateScheduler } from "./update/update-scheduler.js";
import { createProductionUpdateService } from "./update/production-update-runtime.js";

export async function main(args = process.argv.slice(2)): Promise<number> {
  const paths = resolveUpdatePaths();
  const configPath = join(paths.config, "updater.json");
  const configStore = new JsonUpdateConfigStore(configPath);
  const credentialStore = createCredentialStore({
    ...(process.platform === "darwin"
      ? { macosHelperPath: join(dirname(fileURLToPath(import.meta.url)), "..", "native", "macos-keychain-helper") }
      : {}),
  });
  const productionService = createProductionUpdateService({
    paths,
    protocolVersion: 1,
    updaterVersion: "0.1.0",
    ...(process.platform === "darwin"
      ? { macosHelperPath: join(dirname(fileURLToPath(import.meta.url)), "..", "native", "macos-keychain-helper") }
      : {}),
  });
  const check = () => productionService.checkAndInstall();
  const dependencies = {
    check,
    status: async () => {
      const current = await new VersionStore(paths.root).readCurrent();
      return { running: true, version: current?.activeVersion ?? "uninstalled" };
    },
    configure: async () => {
      const gitlabBaseUrl = argumentValue(args, "--gitlab-base-url");
      const projectId = argumentValue(args, "--project-id");
      if (!gitlabBaseUrl || !projectId || !args.includes("--token-stdin")) throw new Error("configure_arguments_invalid");
      const token = (await readStdin()).trimEnd();
      if (!token) throw new Error("credential_missing");
      const credentialReference = `FlowRivet/GitLabPackageRegistry/${projectId}`;
      await credentialStore.write(credentialReference, token);
      await configStore.save({
        schemaVersion: 1,
        gitlabBaseUrl,
        projectId,
        runtimePackageName: "flowrivet-runtime",
        channelPackageName: "flowrivet-channel",
        channelVersion: "latest",
        credentialReference,
        redirectHostAllowlist: [],
      });
      return { configured: true };
    },
    run: async () => {
      const scheduler = new UpdateScheduler({ check, installationId: paths.root });
      await scheduler.start();
      await new Promise<void>((resolve) => {
        const stop = () => { scheduler.stop(); resolve(); };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return { stopped: true };
    },
    uninstallStartup: async () => ({ removed: false }),
    write: (line: string) => process.stdout.write(`${line}\n`),
  };
  return runCli(args, dependencies);
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
