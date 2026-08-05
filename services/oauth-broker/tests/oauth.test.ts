import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OAuthTransactions } from "../src/auth/transactions.js";
import { buildAuthorizationUrl, redactOAuthData } from "../src/auth/tapd-oauth.js";
import { exchangeTapdCode } from "../src/auth/token-exchange.js";

const callbackUri = "https://oauth.flowrivet.example/tapd/callback";
const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("OAuthTransactions", () => {
  it("creates unpredictable states and validates the PKCE transaction proof once", () => {
    const store = new OAuthTransactions({ allowedCallbacks: [callbackUri] });
    const first = store.create({ callbackUri, codeChallenge: challenge });
    const second = store.create({ callbackUri, codeChallenge: challenge });

    expect(first.state).not.toBe(second.state);
    store.complete(first.state, {
      accessToken: "tapd-access-token",
      expiresIn: 7200,
      resource: { type: "workspace", workspaceId: "50396062" },
    });
    expect(() => store.redeem(first.id, "wrong-verifier".repeat(5))).toThrow(
      "transaction proof",
    );
    expect(store.redeem(first.id, verifier).accessToken).toBe("tapd-access-token");
    expect(() => store.redeem(first.id, verifier)).toThrow("already redeemed");
  });

  it("rejects callbacks, expired state, CSRF state and the wrong resource", () => {
    let now = 1_000;
    const store = new OAuthTransactions({
      allowedCallbacks: [callbackUri],
      now: () => now,
      ttlMs: 300_000,
    });
    expect(() =>
      store.create({ callbackUri: "https://attacker.example/callback", codeChallenge: challenge }),
    ).toThrow("callback");

    const transaction = store.create({
      callbackUri,
      codeChallenge: challenge,
      expectedWorkspaceId: "50396062",
    });
    expect(() => store.complete("wrong-state", token())).toThrow("state");
    expect(() => store.complete(transaction.state, token("56536239"))).toThrow("resource");
    now += 300_001;
    expect(() => store.complete(transaction.state, token())).toThrow("expired");
  });
});

describe("TAPD OAuth", () => {
  it("builds a user authorization URL without secret or token material", () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "tapd-app-test",
        callbackUri,
        state: "random-state",
        scopes: ["story#read", "workspace#read"],
      }),
    );
    expect(url.origin).toBe("https://www.tapd.cn");
    expect(url.searchParams.get("auth_by")).toBe("user");
    expect(url.searchParams.get("scope")).toBe("story#read workspace#read");
    expect(url.toString()).not.toContain("secret");
  });

  it("redacts OAuth credentials and authorization codes", () => {
    expect(
      redactOAuthData({ access_token: "token-value", code: "auth-code", state: "state-value" }),
    ).toEqual({ access_token: "[REDACTED]", code: "[REDACTED]", state: "[REDACTED]" });
  });

  it("exchanges a code with Basic auth without logging credentials", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 1,
          data: {
            access_token: "returned-token",
            expires_in: 7200,
            token_type: "Bearer",
            scope: "story#read",
            resource: { type: "workspace", workspace_id: 50396062 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await exchangeTapdCode({
      clientId: "client",
      clientSecret: "fixture-secret",
      code: "fixture-code",
      callbackUri,
      fetch: request,
    });
    expect(result.accessToken).toBe("returned-token");
    const [, init] = request.mock.calls[0];
    expect(String(init?.headers)).not.toContain("fixture-secret");
    expect(init?.body).not.toContain("fixture-secret");
  });
});

function token(workspaceId = "50396062") {
  return {
    accessToken: "tapd-access-token",
    expiresIn: 7200,
    resource: { type: "workspace" as const, workspaceId },
  };
}
