export function createLaunchAgentPlist(executablePath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>cn.flowrivet.updater</string><key>ProgramArguments</key><array><string>${escapeXml(executablePath)}</string><string>run</string></array><key>RunAtLoad</key><true/></dict></plist>\n`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
