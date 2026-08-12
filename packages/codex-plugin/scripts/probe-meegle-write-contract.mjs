import {
  isMain,
  printProbeResult,
  resolveCommand,
  runCommand,
} from "./probe-runtime.mjs";

export async function probeMeegleWriteContract(dependencies = {}) {
  const resolve = dependencies.resolveCommand ?? resolveCommand;
  const run = dependencies.runCommand ?? runCommand;
  const executablePath = await resolve("meegle");
  if (!executablePath) {
    return { ok: false, capability: "meegle_write", errorCode: "provider_cli_missing" };
  }
  const help = await run(executablePath, ["--help"]);
  if (help.exitCode !== 0) {
    return { ok: false, capability: "meegle_write", errorCode: "provider_cli_unsupported" };
  }
  return {
    ok: true,
    capability: "meegle_write",
    comments: "unsupported",
    childItems: "unsupported",
    fields: "unsupported",
    transitions: "unsupported",
  };
}

if (isMain(import.meta.url)) printProbeResult(await probeMeegleWriteContract());
