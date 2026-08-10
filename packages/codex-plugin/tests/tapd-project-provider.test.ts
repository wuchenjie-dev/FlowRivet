import { describe, expect, it, vi } from "vitest";

import type { CredentialStore } from "../src/auth/credential-store.js";
import {
  StoredTapdProjectCredentialResolver,
  TapdProjectProvider,
} from "../src/projects/tapd-project-provider.js";

function credentials() {
  return {
    resolve: vi.fn().mockResolvedValue({
      token: "personal-token",
      accountDisplayName: "wuchenjie",
    }),
  };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TAPD project provider", () => {
  it("discovers active projects and filters organization nodes", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      status: 1,
      data: [
        { Workspace: { id: "50396062", name: "ABF 产品研发", pretty_name: "abf", category: "product", status: "normal" } },
        { Workspace: { id: "66238498", name: "测试企业", category: "organization", status: "normal" } },
        { id: "56536239", name: "已停用项目", category: "product", status: "closed" },
      ],
      info: "success",
    }));
    const provider = new TapdProjectProvider({ credentialResolver: credentials(), fetcher });

    await expect(provider.discoverProjects()).resolves.toEqual([{
      externalId: "50396062",
      name: "ABF 产品研发",
      prettyName: "abf",
    }]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.tapd.cn/workspaces/user_participant_projects?nick=wuchenjie",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer personal-token" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns a provider-neutral connection", async () => {
    const provider = new TapdProjectProvider({ credentialResolver: credentials() });
    await expect(provider.getConnection()).resolves.toEqual({
      providerId: "tapd",
      displayName: "TAPD",
      state: "connected",
      accountDisplayName: "wuchenjie",
    });
  });

  it.each([
    ["50396062", "50396062"],
    ["https://www.tapd.cn/tapd_fe/50396062/story/list", "50396062"],
    ["https://www.tapd.cn/50396062/prong/stories/stories_list", "50396062"],
  ])("resolves project input %s", async (input, expectedId) => {
    const fetcher = vi.fn().mockResolvedValue(response({
      status: 1,
      data: { Workspace: { id: expectedId, name: "ABF 产品研发", pretty_name: "abf" } },
    }));
    const provider = new TapdProjectProvider({ credentialResolver: credentials(), fetcher });

    await expect(provider.resolveProject(input)).resolves.toEqual({
      externalId: expectedId,
      name: "ABF 产品研发",
      prettyName: "abf",
    });
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.tapd.cn/workspaces/get_workspace_info?workspace_id=${expectedId}`,
      expect.any(Object),
    );
  });

  it.each([
    [401, "provider_unauthorized"],
    [403, "provider_unauthorized"],
    [500, "provider_unavailable"],
  ] as const)("maps discovery HTTP %s to %s", async (status, code) => {
    const provider = new TapdProjectProvider({
      credentialResolver: credentials(),
      fetcher: vi.fn().mockResolvedValue(new Response("upstream-secret-body", { status })),
    });

    await expect(provider.discoverProjects()).rejects.toMatchObject({ code });
    await expect(provider.discoverProjects()).rejects.not.toThrow("upstream-secret-body");
  });

  it.each([
    [403, "project_forbidden"],
    [404, "project_not_found"],
  ] as const)("maps project lookup HTTP %s to %s", async (status, code) => {
    const provider = new TapdProjectProvider({
      credentialResolver: credentials(),
      fetcher: vi.fn().mockResolvedValue(new Response(null, { status })),
    });
    await expect(provider.resolveProject("50396062")).rejects.toMatchObject({ code });
  });

  it("maps invalid input, API failure envelopes, invalid JSON and network errors", async () => {
    const invalidInput = new TapdProjectProvider({ credentialResolver: credentials() });
    await expect(invalidInput.resolveProject("not a TAPD project"))
      .rejects.toMatchObject({ code: "project_not_found" });

    const envelope = new TapdProjectProvider({
      credentialResolver: credentials(),
      fetcher: vi.fn().mockResolvedValue(response({ status: 0, info: "denied" })),
    });
    await expect(envelope.discoverProjects())
      .rejects.toMatchObject({ code: "project_discovery_unavailable" });

    const invalidJson = new TapdProjectProvider({
      credentialResolver: credentials(),
      fetcher: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    });
    await expect(invalidJson.discoverProjects())
      .rejects.toMatchObject({ code: "provider_unavailable" });

    const network = new TapdProjectProvider({
      credentialResolver: credentials(),
      fetcher: vi.fn().mockRejectedValue(new Error("network failed personal-token")),
    });
    await expect(network.discoverProjects())
      .rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(network.discoverProjects()).rejects.not.toThrow("personal-token");
  });

  it("resolves stored credentials without exposing them to generic callers", async () => {
    const store: CredentialStore = {
      readTapdToken: vi.fn().mockResolvedValue("stored-token"),
      writeTapdToken: vi.fn(),
      deleteTapdToken: vi.fn(),
    };
    const identityClient = {
      validate: vi.fn().mockResolvedValue({ userName: "wuchenjie" }),
    };
    const resolver = new StoredTapdProjectCredentialResolver({ store, identityClient });

    await expect(resolver.resolve()).resolves.toEqual({
      token: "stored-token",
      accountDisplayName: "wuchenjie",
    });
  });

  it("rejects a stored token that no longer matches the expected sync identity", async () => {
    const store: CredentialStore = {
      readTapdToken: vi.fn().mockResolvedValue("new-account-token"),
      writeTapdToken: vi.fn(),
      deleteTapdToken: vi.fn(),
    };
    const identityClient = {
      validate: vi.fn().mockResolvedValue({
        userName: "bob",
        accountKey: "user-2",
        companyId: "tenant-1",
      }),
    };
    const resolver = new StoredTapdProjectCredentialResolver({ store, identityClient });

    await expect(resolver.resolve({
      accountKey: "user-1",
      tenantKey: "tenant-1",
    })).rejects.toMatchObject({ code: "provider_unauthorized" });
  });

  it("maps a missing stored credential to provider_not_connected", async () => {
    const resolver = new StoredTapdProjectCredentialResolver({
      store: {
        readTapdToken: vi.fn().mockResolvedValue(undefined),
        writeTapdToken: vi.fn(),
        deleteTapdToken: vi.fn(),
      },
      identityClient: { validate: vi.fn() },
    });
    await expect(resolver.resolve()).rejects.toMatchObject({ code: "provider_not_connected" });
  });
});
