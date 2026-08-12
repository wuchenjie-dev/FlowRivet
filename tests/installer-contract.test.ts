import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("FlowRivet installers", () => {
  it("keeps the Windows token off argv and installs at user scope", async () => {
    const script = await readFile("scripts/install/install-flowrivet.ps1", "utf8");
    expect(script).toContain("[Environment]::GetFolderPath('LocalApplicationData')");
    expect(script).toContain("Read-Host \"GitLab Deploy Token\" -AsSecureString");
    expect(script).toContain("StandardInput.WriteLine");
    expect(script).toContain("ArgumentList.Add('configure')");
    expect(script).toContain("ArgumentList.Add('--token-stdin')");
    expect(script).not.toMatch(/--token\s+\$plainToken/u);
  });

  it("uses Keychain or Secret Service and user startup on Unix", async () => {
    const script = await readFile("scripts/install/install-flowrivet.sh", "utf8");
    expect(script).toContain('read -r -s -p "GitLab Deploy Token: " FLOWRIVET_TOKEN');
    expect(script).toContain("configure --token-stdin");
    expect(script).toContain("$HOME/Library/Application Support/FlowRivet");
    expect(script).toContain("$HOME/.local/share/flowrivet");
    expect(script).not.toMatch(/--token[ =]"?\$FLOWRIVET_TOKEN/u);
    expect(script).not.toMatch(/curl[^\n]*-(?:H|-header)[^\n]*FLOWRIVET_TOKEN/u);
  });
});
