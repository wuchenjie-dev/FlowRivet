import { describe, expect, it, vi } from "vitest";

import type {
  MeegleAuthStatus,
  MeegleUser,
} from "../src/meegle/meegle-cli-contracts.js";
import type {
  MeegleDeviceAttempt,
  MeegleDevicePollResult,
} from "../src/meegle/meegle-cli-client.js";
import {
  MeegleLoginDriver,
  type MeegleLoginClient,
} from "../src/meegle/meegle-login-driver.js";

const attempt: MeegleDeviceAttempt = {
  profileName: "default",
  verificationUri: "https://open.feishu.cn/device",
  verificationUriComplete: "https://open.feishu.cn/device?code=example",
  userCode: "USER-CODE",
  clientId: "client-example",
  deviceCode: "device-example",
  expiresInSeconds: 300,
  intervalMs: 5_000,
  expiresAt: "2026-08-11T00:05:00.000Z",
};
const status: MeegleAuthStatus = {
  authenticated: true,
  host: "project.feishu.cn",
};
const user: MeegleUser = {
  name_cn: "Example User",
  name_en: "Example User",
  user_key: "user-example",
};

class FakeClient implements MeegleLoginClient {
  readonly getCurrentProfile = vi.fn(async () => "default");
  readonly initializeDeviceLogin = vi.fn(async () => attempt);
  readonly pollDeviceLogin = vi.fn(async (): Promise<MeegleDevicePollResult> => ({
    state: "pending",
  }));
  readonly getAuthStatus = vi.fn(async () => status);
  readonly getCurrentUser = vi.fn(async () => user);
}

describe("Meegle login driver", () => {
  it("initializes and polls with the captured profile", async () => {
    const client = new FakeClient();
    const driver = new MeegleLoginDriver(client);
    const signal = new AbortController().signal;

    await expect(driver.captureProfile()).resolves.toBe("default");
    const initialized = await driver.initialize("default", signal);
    await expect(driver.poll("default", initialized.attempt, signal))
      .resolves.toEqual({ state: "pending" });

    expect(client.initializeDeviceLogin)
      .toHaveBeenCalledWith("default", "project.feishu.cn", signal);
    expect(client.pollDeviceLogin).toHaveBeenCalledWith("default", attempt, signal);
    expect(initialized).toMatchObject({
      verificationUriComplete: attempt.verificationUriComplete,
      intervalMs: 5_000,
    });
  });

  it("rejects a profile change before polling", async () => {
    const client = new FakeClient();
    client.getCurrentProfile.mockResolvedValue("other");
    const driver = new MeegleLoginDriver(client);

    await expect(driver.poll(
      "default", attempt, new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_profile_changed" });
    expect(client.pollDeviceLogin).not.toHaveBeenCalled();
  });

  it("verifies status and identity for the captured profile", async () => {
    const client = new FakeClient();
    const driver = new MeegleLoginDriver(client);

    await expect(driver.verifyIdentity("default")).resolves.toEqual({
      profileName: "default",
      accountKey: "user-example",
      accountDisplayName: "Example User",
    });
    expect(client.getAuthStatus).toHaveBeenCalledWith("default");
    expect(client.getCurrentUser).toHaveBeenCalledWith("default");
  });

  it("does not read identity when the captured profile is disconnected", async () => {
    const client = new FakeClient();
    client.getAuthStatus.mockResolvedValue({
      authenticated: false,
      host: "project.feishu.cn",
    });
    const driver = new MeegleLoginDriver(client);

    await expect(driver.verifyIdentity("default"))
      .rejects.toMatchObject({ code: "provider_not_connected" });
    expect(client.getCurrentUser).not.toHaveBeenCalled();
  });
});
