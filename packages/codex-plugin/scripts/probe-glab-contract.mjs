import {
  isMain,
  printProbeResult,
  resolveCommand,
  runCommand,
} from "./probe-runtime.mjs";

const host = "gitlab-aiabu.ruijie.com.cn";

export async function probeGlabContract(dependencies = {}) {
  const resolve = dependencies.resolveCommand ?? resolveCommand;
  const run = dependencies.runCommand ?? runCommand;
  const executablePath = await resolve("glab");
  if (!executablePath) {
    return { ok: false, capability: "gitlab", errorCode: "gitlab_cli_missing" };
  }

  const versionResult = await run(executablePath, ["version"]);
  if (versionResult.exitCode !== 0) {
    return { ok: false, capability: "gitlab", errorCode: "gitlab_cli_unsupported" };
  }
  const version = extractVersion(versionResult.stdout);
  if (!version) {
    return { ok: false, capability: "gitlab", errorCode: "gitlab_output_invalid" };
  }

  const authResult = await run(executablePath, ["auth", "status", "--hostname", host]);
  if (authResult.exitCode !== 0) {
    return {
      ok: false,
      capability: "gitlab",
      version,
      errorCode: "gitlab_not_connected",
    };
  }

  const probes = await Promise.all([
    run(executablePath, ["repo", "list", "--mine", "--page", "1", "--per-page", "2", "--output", "json"]),
    run(executablePath, ["mr", "list", "-R", "cc/flowrivet", "--page", "1", "--per-page", "2", "--output", "json"]),
    run(executablePath, ["ci", "list", "-R", "cc/flowrivet", "--page", "1", "--per-page", "2", "--output", "json"]),
  ]);

  return {
    ok: true,
    capability: "gitlab",
    version,
    auth: true,
    projects: isJsonArray(probes[0]),
    mergeRequests: isJsonArray(probes[1]),
    pipelines: isJsonArray(probes[2]),
  };
}

function extractVersion(value) {
  return value.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
}

function isJsonArray(result) {
  if (!result || result.exitCode !== 0) return false;
  try {
    return Array.isArray(JSON.parse(result.stdout));
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) printProbeResult(await probeGlabContract());
