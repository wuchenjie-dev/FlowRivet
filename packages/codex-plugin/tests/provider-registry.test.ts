import { describe, expect, it } from "vitest";

import type { ProviderConnection } from "../src/contracts/providers.js";
import {
  ProviderRegistry,
  ProviderRegistryError,
  type ProviderRegistration,
} from "../src/providers/provider-registry.js";

function registration(
  id: string,
  connection: ProviderConnection,
): ProviderRegistration {
  return {
    id,
    displayName: connection.displayName,
    loginMode: id === "tapd" ? "personal_token" : "device_code",
    auth: {
      getConnection: async () => connection,
    },
    workItems: {
      id,
      queryMode: "project_scoped",
      listProjectWorkItems: async () => ({
        projectExternalId: "PROJ",
        scopes: [],
      }),
    },
  };
}

describe("provider registry", () => {
  it("looks up registered provider capabilities", () => {
    const feishu = registration("feishu-project", {
      providerId: "feishu-project",
      displayName: "飞书项目",
      state: "connected",
      accountDisplayName: "Example User",
    });
    const registry = new ProviderRegistry([feishu]);

    expect(registry.get("feishu-project")).toBe(feishu);
    expect(registry.has("feishu-project")).toBe(true);
  });

  it("returns only non-sensitive provider descriptors and connection state", async () => {
    const registry = new ProviderRegistry([
      registration("feishu-project", {
        providerId: "feishu-project",
        displayName: "飞书项目",
        state: "connected",
        accountDisplayName: "Example User",
        profileName: "default",
      }),
      registration("tapd", {
        providerId: "tapd",
        displayName: "TAPD",
        state: "disconnected",
      }),
    ]);

    await expect(registry.list()).resolves.toEqual([
      {
        providerId: "feishu-project",
        displayName: "飞书项目",
        loginMode: "device_code",
        connection: {
          providerId: "feishu-project",
          displayName: "飞书项目",
          state: "connected",
          accountDisplayName: "Example User",
          profileName: "default",
        },
        capabilities: {
          projects: false,
          details: false,
        },
      },
      {
        providerId: "tapd",
        displayName: "TAPD",
        loginMode: "personal_token",
        connection: {
          providerId: "tapd",
          displayName: "TAPD",
          state: "disconnected",
        },
        capabilities: {
          projects: false,
          details: false,
        },
      },
    ]);
    expect(JSON.stringify(await registry.list())).not.toMatch(
      /"(?:token|secret|authorization|verificationUri|deviceCode|executable|cliArgs)"\s*:/i,
    );
  });

  it("rejects duplicate and unknown providers with stable errors", () => {
    const tapd = registration("tapd", {
      providerId: "tapd",
      displayName: "TAPD",
      state: "connected",
    });

    expect(() => new ProviderRegistry([tapd, tapd])).toThrowError(
      expect.objectContaining({ code: "provider_already_registered" }),
    );
    expect(() => new ProviderRegistry([tapd]).get("missing")).toThrowError(
      expect.objectContaining({ code: "provider_not_registered" }),
    );
    expect(new ProviderRegistry([tapd]).get("tapd")).toBe(tapd);
    expect(ProviderRegistryError).toBeDefined();
  });
});
