import { describe, expect, it, vi } from "vitest";

import type {
  MeegleAuthStatus,
  MeegleUser,
} from "../src/meegle/meegle-cli-contracts.js";
import {
  MeegleCliError,
} from "../src/meegle/meegle-cli-client.js";
import {
  MeegleAuthService,
  type MeegleAuthClient,
} from "../src/meegle/meegle-auth-service.js";

const connectedStatus: MeegleAuthStatus = {
  authenticated: true,
  expires_in_minutes: 119,
  host: "project.feishu.cn",
};
const user: MeegleUser = {
  name_cn: "Example User",
  name_en: "Example User",
  user_key: "user_example",
};

class FakeClient implements MeegleAuthClient {
  readonly getVersion = vi.fn(async () => "1.0.19");
  readonly getCurrentProfile = vi.fn(async () => "default");
  readonly getAuthStatus = vi.fn(async () => connectedStatus);
  readonly getCurrentUser = vi.fn(async () => user);
  readonly logout = vi.fn(async () => undefined);
}

function service(client: FakeClient) {
  return new MeegleAuthService({
    client,
  });
}

describe("Meegle auth service", () => {
  it("maps missing CLI, disconnected credentials, and server failures", async () => {
    const missing = new FakeClient();
    missing.getVersion.mockRejectedValue(new MeegleCliError("provider_cli_missing"));
    await expect(service(missing).getConnection()).resolves.toMatchObject({ state: "cli_missing" });

    const disconnected = new FakeClient();
    disconnected.getAuthStatus.mockResolvedValue({
      authenticated: false,
      host: "project.feishu.cn",
      reason: "no local token",
    });
    await expect(service(disconnected).getConnection()).resolves.toMatchObject({
      state: "disconnected",
      profileName: "default",
    });

    const unavailable = new FakeClient();
    unavailable.getAuthStatus.mockRejectedValue(new MeegleCliError("provider_unavailable"));
    await expect(service(unavailable).getConnection()).resolves.toMatchObject({ state: "unavailable" });
  });

  it("returns connected identity and treats a rejected identity call as expired", async () => {
    const client = new FakeClient();
    await expect(service(client).getConnection()).resolves.toEqual({
      providerId: "feishu-project",
      displayName: "飞书项目",
      state: "connected",
      accountDisplayName: "Example User",
      profileName: "default",
    });

    client.getCurrentUser.mockRejectedValue(new MeegleCliError("provider_unauthorized"));
    await expect(service(client).getConnection()).resolves.toMatchObject({
      state: "expired",
      profileName: "default",
    });
  });

  it("logs out the captured profile and clears the remembered identity", async () => {
    const client = new FakeClient();
    const auth = service(client);
    await auth.getConnection();

    await expect(auth.disconnect()).resolves.toEqual({
      providerId: "feishu-project",
      displayName: "飞书项目",
      state: "disconnected",
      profileName: "default",
    });
    expect(client.logout).toHaveBeenCalledWith("default");
    expect(auth.getSessionIdentity()).toBeUndefined();
  });
});
