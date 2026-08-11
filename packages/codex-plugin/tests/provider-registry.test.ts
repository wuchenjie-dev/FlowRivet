import { describe, expect, it } from "vitest";

import type { ProviderConnection } from "../src/contracts/providers.js";
import {
  ProviderRegistry,
  ProviderRegistryError,
  type ProviderRegistration,
} from "../src/providers/provider-registry.js";
import type { ProviderLoginDriver } from "../src/providers/provider-login-driver.js";

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

  it("registers a login driver without exposing it from descriptors", async () => {
    const login: ProviderLoginDriver = {
      allowedBrowserHosts: ["open.feishu.cn"],
      captureProfile: async () => "default",
      initialize: async () => ({
        attempt: { deviceCode: "internal-only" },
        verificationUri: "https://open.feishu.cn/device",
        verificationUriComplete: "https://open.feishu.cn/device?code=example",
        userCode: "EXAMPLE-CODE",
        expiresAt: "2026-08-11T00:05:00.000Z",
        intervalMs: 5_000,
      }),
      poll: async () => ({ state: "pending" }),
      verifyIdentity: async () => ({
        profileName: "default",
        accountKey: "user-example",
        accountDisplayName: "Example User",
      }),
      dispose: async () => undefined,
    };
    const feishu = { ...registration("feishu-project", {
      providerId: "feishu-project",
      displayName: "飞书项目",
      state: "disconnected",
    }), login };
    const registry = new ProviderRegistry([feishu]);

    expect(registry.get("feishu-project").login).toBe(login);
    expect(JSON.stringify(await registry.list())).not.toContain("allowedBrowserHosts");
    expect(JSON.stringify(await registry.list())).not.toContain("internal-only");
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
