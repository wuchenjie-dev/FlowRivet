export interface CliDependencies {
  check(): Promise<unknown>;
  status(): Promise<unknown>;
  configure(): Promise<unknown> | unknown;
  run(): Promise<unknown>;
  uninstallStartup(): Promise<unknown>;
  write(line: string): void;
}

export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  const command = args[0];
  const json = args.includes("--json");
  try {
    let result: unknown;
    if (command === "check") result = await dependencies.check();
    else if (command === "status") result = await dependencies.status();
    else if (command === "configure") result = await dependencies.configure();
    else if (command === "run") result = await dependencies.run();
    else if (command === "uninstall-startup") result = await dependencies.uninstallStartup();
    else {
      dependencies.write("unknown_command");
      return 2;
    }
    dependencies.write(json ? JSON.stringify(result ?? { outcome: "ok" }) : formatHuman(command, result));
    return 0;
  } catch (error) {
    dependencies.write(json
      ? JSON.stringify({ error: stableErrorCode(error) })
      : stableErrorCode(error));
    return 1;
  }
}

function formatHuman(command: string, result: unknown): string {
  if (result && typeof result === "object" && "version" in result && typeof result.version === "string") {
    return `${command}: ${result.version}`;
  }
  return `${command}: ok`;
}

function stableErrorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) return error.message;
  return "update_failed";
}
