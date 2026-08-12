export function createSystemdUserUnit(executablePath: string): string {
  if (/\r|\n/u.test(executablePath)) throw new Error("updater_path_invalid");
  return `[Unit]\nDescription=FlowRivet updater\n\n[Service]\nExecStart=${executablePath} run\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
}
