import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  exchangeTapdCode,
  TapdTokenExchangeError,
} from "../src/auth/token-exchange.js";
import { createOAuthBroker } from "../src/index.js";
import { createLogger } from "../src/logging.js";
import { resolveRequestId } from "../src/request-context.js";

const servers: ReturnType<typeof createOAuthBroker>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("OAuth Broker HTTP observability", () => {
  it("replaces a multi-value request id", () => {
    expect(
      resolveRequestId({ "x-request-id": ["first-request", "second-request"] }),
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("reuses a valid request id in the response and completion log", async () => {
    const broker = await startBroker();

    const response = await fetch(`${broker.baseUrl}/missing?secret=ignored`, {
      headers: { "x-request-id": "client-request-123" },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("client-request-123");
    expect(broker.event("http.request.completed")).toMatchObject({
      requestId: "client-request-123",
      method: "GET",
      path: "/missing",
      statusCode: 404,
    });
    expect(broker.output()).not.toContain("secret=ignored");
  });

  it.each([undefined, "short", "invalid request id"])(
    "replaces a missing or invalid request id: %s",
    async (requestId) => {
      const broker = await startBroker();
      const headers = requestId ? { "x-request-id": requestId } : undefined;

      const response = await fetch(`${broker.baseUrl}/missing`, { headers });
      const generated = response.headers.get("x-request-id");

      expect(generated).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(broker.event("http.request.completed").requestId).toBe(generated);
      if (requestId) expect(broker.output()).not.toContain(requestId);
    },
  );

  it("correlates rejected requests without logging their input", async () => {
    const broker = await startBroker();

    const response = await fetch(`${broker.baseUrl}/oauth/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "rejected-request-123",
      },
      body: "not-json-fixture-secret",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("rejected-request-123");
    expect(broker.event("http.request.rejected")).toMatchObject({
      requestId: "rejected-request-123",
      method: "POST",
      path: "/oauth/transactions",
      statusCode: 400,
      errorType: "invalid_request",
    });
    expect(broker.event("http.request.completed").requestId).toBe(
      "rejected-request-123",
    );
    expect(broker.output()).not.toContain("not-json-fixture-secret");
  });

  it("correlates the OAuth lifecycle without logging credentials", async () => {
    const broker = await startBroker({
      exchangeCode: async () => ({
        accessToken: "fixture-access-token",
        expiresIn: 7200,
        scope: "user story#read workspace#read",
        resource: { type: "user", userId: "fixture-user", companyId: "66238498" },
      }),
    });
    const verifier = "fixture-verifier-".padEnd(64, "v");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const createdResponse = await fetch(`${broker.baseUrl}/oauth/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "create-request-123" },
      body: JSON.stringify({ codeChallenge: challenge, expectedCompanyId: "66238498" }),
    });
    const created = (await createdResponse.json()) as {
      transactionId: string;
      authorizationUrl: string;
    };
    const state = new URL(created.authorizationUrl).searchParams.get("state")!;
    await fetch(
      `${broker.baseUrl}/oauth/callback?code=fixture-auth-code&state=${encodeURIComponent(state)}`,
      { headers: { "x-request-id": "callback-request-123" } },
    );
    await fetch(`${broker.baseUrl}/oauth/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "redeem-request-123" },
      body: JSON.stringify({ transactionId: created.transactionId, codeVerifier: verifier }),
    });

    const oauthEvents = [
      broker.event("oauth.transaction.created"),
      broker.event("oauth.callback.completed"),
      broker.event("oauth.token.redeemed"),
    ];
    expect(new Set(oauthEvents.map(({ transactionRef }) => transactionRef)).size).toBe(1);
    expect(oauthEvents.map(({ requestId }) => requestId)).toEqual([
      "create-request-123",
      "callback-request-123",
      "redeem-request-123",
    ]);
    for (const secret of [
      created.transactionId,
      state,
      verifier,
      challenge,
      "fixture-access-token",
      "fixture-auth-code",
      "fixture-user",
    ]) {
      expect(broker.output()).not.toContain(secret);
    }
  });

  it("logs a classified TAPD token exchange failure without its response body", async () => {
    const broker = await startBroker({
      exchangeCode: async () => {
        throw new TapdTokenExchangeError(503);
      },
    });
    const verifier = "upstream-verifier-".padEnd(64, "v");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const createdResponse = await fetch(`${broker.baseUrl}/oauth/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codeChallenge: challenge }),
    });
    const created = (await createdResponse.json()) as {
      authorizationUrl: string;
    };
    const state = new URL(created.authorizationUrl).searchParams.get("state")!;

    const response = await fetch(
      `${broker.baseUrl}/oauth/callback?code=upstream-code-secret&state=${encodeURIComponent(state)}`,
      { headers: { "x-request-id": "upstream-request-123" } },
    );

    expect(response.status).toBe(400);
    expect(broker.event("tapd.token_exchange.failed")).toMatchObject({
      requestId: "upstream-request-123",
      upstreamStatus: 503,
      errorType: "tapd_token_exchange_failed",
    });
    expect(broker.output()).not.toContain("upstream-code-secret");
    expect(broker.output()).not.toContain(state);
  });
});

type ExchangeCode = (
  input: Parameters<typeof exchangeTapdCode>[0],
) => ReturnType<typeof exchangeTapdCode>;

async function startBroker(options: { exchangeCode?: ExchangeCode } = {}) {
  const destination = new PassThrough();
  let logs = "";
  destination.on("data", (chunk) => {
    logs += chunk.toString();
  });
  const logger = createLogger("info", destination);
  const server = createOAuthBroker(
    {
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      callbackUri: "http://127.0.0.1:43119/oauth/callback",
      scopes: ["user", "story#read", "workspace#read"],
      port: 43119,
      logLevel: "info",
    },
    { logger, exchangeCode: options.exchangeCode },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    output: () => logs,
    event: (name: string) => {
      const entry = logs
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(({ event }) => event === name);
      expect(entry, `missing log event ${name}`).toBeDefined();
      return entry!;
    },
  };
}
