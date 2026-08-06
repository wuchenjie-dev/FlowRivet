import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
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
});

async function startBroker() {
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
    { logger },
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
