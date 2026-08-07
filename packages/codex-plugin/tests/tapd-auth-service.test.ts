import { describe, expect, it, vi } from "vitest";

import type { CredentialStore } from "../src/auth/credential-store.js";
import {
  TapdAuthService,
} from "../src/auth/tapd-auth-service.js";
import {
  TapdIdentityClient,
  TapdIdentityError,
} from "../src/auth/tapd-identity-client.js";

function credentialStore(token?: string): CredentialStore & {
  readTapdToken: ReturnType<typeof vi.fn>;
  writeTapdToken: ReturnType<typeof vi.fn>;
  deleteTapdToken: ReturnType<typeof vi.fn>;
} {
  return {
    readTapdToken: vi.fn().mockResolvedValue(token),
    writeTapdToken: vi.fn().mockResolvedValue(undefined),
    deleteTapdToken: vi.fn().mockResolvedValue(undefined),
  };
}

describe("TAPD identity client", () => {
  it("validates a bearer token and returns non-sensitive identity", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 1,
      data: {
        User: {
          name: "吴晨杰",
          company_name: "FlowRivet 测试企业",
          company_id: "66238498",
        },
      },
      info: "success",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TapdIdentityClient({ fetcher });

    await expect(client.validate("personal-token")).resolves.toEqual({
      userName: "吴晨杰",
      companyName: "FlowRivet 测试企业",
      companyId: "66238498",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.tapd.cn/users/info",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer personal-token" }),
      }),
    );
  });

  it("accepts the flat nick-only response returned for personal tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 1,
      data: { nick: "wuchenjie" },
      info: "success",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TapdIdentityClient({ fetcher });

    await expect(client.validate("personal-token")).resolves.toEqual({
      userName: "wuchenjie",
    });
  });

  it.each([
    [401, "invalid_token"],
    [403, "permission_denied"],
    [500, "tapd_unavailable"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    const client = new TapdIdentityClient({
      fetcher: vi.fn().mockResolvedValue(new Response("upstream body", { status })),
    });

    await expect(client.validate("secret-token")).rejects.toMatchObject({ code });
    await expect(client.validate("secret-token")).rejects.not.toThrow("upstream body");
  });

  it("maps network errors without retaining their message", async () => {
    const client = new TapdIdentityClient({
      fetcher: vi.fn().mockRejectedValue(new Error("socket failed with secret-token")),
    });

    await expect(client.validate("secret-token")).rejects.toEqual(
      new TapdIdentityError("tapd_unavailable"),
    );
  });
});

describe("TAPD auth service", () => {
  it("stores a token only after successful validation", async () => {
    const store = credentialStore();
    const identityClient = {
      validate: vi.fn().mockResolvedValue({
        userName: "吴晨杰",
        companyName: "FlowRivet 测试企业",
        companyId: "66238498",
      }),
    };
    const service = new TapdAuthService({ store, identityClient });

    await expect(service.login("personal-token")).resolves.toEqual({
      ok: true,
      connection: {
        tapd: "connected",
        userName: "吴晨杰",
        companyName: "FlowRivet 测试企业",
      },
    });
    expect(store.writeTapdToken).toHaveBeenCalledWith("personal-token");
  });

  it("does not store an invalid token", async () => {
    const store = credentialStore();
    const service = new TapdAuthService({
      store,
      identityClient: {
        validate: vi.fn().mockRejectedValue(new TapdIdentityError("invalid_token")),
      },
    });

    await expect(service.login("invalid-token")).resolves.toMatchObject({
      ok: false,
      errorCode: "invalid_token",
      connection: { tapd: "disconnected" },
    });
    expect(store.writeTapdToken).not.toHaveBeenCalled();
  });

  it("restores a valid stored credential", async () => {
    const store = credentialStore("stored-token");
    const service = new TapdAuthService({
      store,
      identityClient: {
        validate: vi.fn().mockResolvedValue({
          userName: "吴晨杰",
          companyName: "FlowRivet 测试企业",
          companyId: "66238498",
        }),
      },
    });

    await expect(service.getConnectionStatus()).resolves.toMatchObject({
      ok: true,
      connection: { tapd: "connected", userName: "吴晨杰" },
    });
  });

  it("marks an invalid stored credential expired without deleting it", async () => {
    const store = credentialStore("expired-token");
    const service = new TapdAuthService({
      store,
      identityClient: {
        validate: vi.fn().mockRejectedValue(new TapdIdentityError("invalid_token")),
      },
    });

    await expect(service.getConnectionStatus()).resolves.toMatchObject({
      ok: false,
      errorCode: "invalid_token",
      connection: { tapd: "expired" },
    });
    expect(store.deleteTapdToken).not.toHaveBeenCalled();
  });

  it("keeps a stored credential when TAPD is temporarily unavailable", async () => {
    const store = credentialStore("stored-token");
    const service = new TapdAuthService({
      store,
      identityClient: {
        validate: vi.fn().mockRejectedValue(new TapdIdentityError("tapd_unavailable")),
      },
    });

    await expect(service.getConnectionStatus()).resolves.toMatchObject({
      ok: false,
      errorCode: "tapd_unavailable",
      connection: { tapd: "disconnected" },
    });
    expect(store.deleteTapdToken).not.toHaveBeenCalled();
  });

  it("disconnects by deleting the stored credential", async () => {
    const store = credentialStore("stored-token");
    const service = new TapdAuthService({
      store,
      identityClient: { validate: vi.fn() },
    });

    await expect(service.disconnect()).resolves.toEqual({
      ok: true,
      connection: { tapd: "disconnected" },
    });
    expect(store.deleteTapdToken).toHaveBeenCalledOnce();
  });
});
