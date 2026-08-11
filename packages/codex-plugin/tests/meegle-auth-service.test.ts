import { describe, expect, it, vi } from "vitest";

import type {
  MeegleAuthStatus,
  MeegleUser,
} from "../src/meegle/meegle-cli-contracts.js";
import {
  MeegleCliError,
  type MeegleDeviceLoginEvent,
} from "../src/meegle/meegle-cli-client.js";
import {
  MeegleAuthError,
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
  readonly startDeviceLogin = vi.fn<MeegleAuthClient["startDeviceLogin"]>();
  readonly logout = vi.fn(async () => undefined);
}

function service(client: FakeClient, options: { clock?: () => Date } = {}) {
  let transactionSequence = 0;
  return new MeegleAuthService({
    client,
    transactionId: () => `transaction-example-${++transactionSequence}`,
    ...(options.clock ? { clock: options.clock } : {}),
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

  it("reuses one in-flight login per profile and reports authorizing", async () => {
    const client = new FakeClient();
    client.getAuthStatus.mockResolvedValue({
      authenticated: false,
      host: "project.feishu.cn",
      reason: "no local token",
    });
    client.startDeviceLogin.mockImplementation(async (_host, signal, onEvent) => {
      onEvent(verificationEvent());
      await waitForAbort(signal);
    });
    const auth = service(client);

    const first = await auth.startLogin();
    const second = await auth.startLogin();

    expect(second).toEqual(first);
    expect(client.startDeviceLogin).toHaveBeenCalledOnce();
    await expect(auth.getConnection()).resolves.toMatchObject({ state: "authorizing" });
    await auth.cancelLogin(first.transactionId);
  });

  it("opens the complete verification URI returned by the CLI", async () => {
    const client = new FakeClient();
    client.startDeviceLogin.mockImplementation(async (_host, signal, onEvent) => {
      onEvent(verificationEvent());
      await waitForAbort(signal);
    });
    const auth = service(client);

    const transaction = await auth.startLogin();

    expect(transaction.verificationUri)
      .toBe("https://open.feishu.cn/device?code=example");
    await auth.cancelLogin(transaction.transactionId);
  });

  it("isolates login transactions when the current profile changes", async () => {
    const client = new FakeClient();
    client.getCurrentProfile
      .mockResolvedValueOnce("profile-a")
      .mockResolvedValueOnce("profile-b");
    client.startDeviceLogin.mockImplementation(async (_host, signal, onEvent) => {
      onEvent(verificationEvent());
      await waitForAbort(signal);
    });
    const auth = service(client);

    const first = await auth.startLogin();
    const second = await auth.startLogin();

    expect(second.transactionId).not.toBe(first.transactionId);
    expect(client.startDeviceLogin).toHaveBeenCalledTimes(2);
    await auth.cancelLogin(first.transactionId);
    await auth.cancelLogin(second.transactionId);
  });

  it("cancels a matching transaction and rejects unknown transaction IDs", async () => {
    const client = new FakeClient();
    client.getAuthStatus.mockResolvedValue({
      authenticated: false,
      host: "project.feishu.cn",
      reason: "no local token",
    });
    client.startDeviceLogin.mockImplementation(async (_host, signal, onEvent) => {
      onEvent(verificationEvent());
      await waitForAbort(signal);
    });
    const auth = service(client);
    const transaction = await auth.startLogin();

    await expect(auth.cancelLogin(transaction.transactionId)).resolves.toMatchObject({
      state: "disconnected",
    });
    await expect(auth.cancelLogin("unknown")).rejects.toMatchObject({
      code: "provider_login_transaction_not_found",
    });
  });

  it("caps an authorization transaction at five minutes", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.startDeviceLogin.mockImplementation(async (_host, signal, onEvent) => {
      onEvent(verificationEvent("2026-08-11T01:00:00.000Z"));
      await waitForAbort(signal);
    });
    const auth = service(client, {
      clock: () => new Date("2026-08-11T00:00:00.000Z"),
    });

    const transaction = await auth.startLogin();
    expect(transaction.expiresAt).toBe("2026-08-11T00:05:00.000Z");
    await vi.advanceTimersByTimeAsync(300_001);
    await expect(auth.cancelLogin(transaction.transactionId)).rejects.toBeInstanceOf(MeegleAuthError);
    vi.useRealTimers();
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

function verificationEvent(
  expiresAt = "2026-08-11T00:10:00.000Z",
): Extract<MeegleDeviceLoginEvent, { type: "verification" }> {
  return {
    type: "verification",
    verificationUri: "https://open.feishu.cn/device",
    verificationUriComplete: "https://open.feishu.cn/device?code=example",
    userCode: "USER-CODE",
    expiresAt,
  };
}

function waitForAbort(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
