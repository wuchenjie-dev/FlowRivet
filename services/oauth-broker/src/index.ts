import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildAuthorizationUrl } from "./auth/tapd-oauth.js";
import { OAuthTransactions } from "./auth/transactions.js";
import { exchangeTapdCode } from "./auth/token-exchange.js";
import { loadBrokerConfig, type BrokerConfig } from "./config.js";

export function createOAuthBroker(config: BrokerConfig) {
  const transactions = new OAuthTransactions({ allowedCallbacks: [config.callbackUri] });
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "POST" && url.pathname === "/oauth/transactions") {
        const input = await readJson(request);
        const transaction = transactions.create({
          callbackUri: config.callbackUri,
          codeChallenge: stringField(input, "codeChallenge"),
          expectedCompanyId: optionalString(input, "expectedCompanyId"),
        });
        return json(response, 201, {
          transactionId: transaction.id,
          expiresAt: transaction.expiresAt,
          authorizationUrl: buildAuthorizationUrl({
            clientId: config.clientId,
            callbackUri: config.callbackUri,
            state: transaction.state,
            scopes: config.scopes,
          }),
        });
      }
      if (request.method === "GET" && url.pathname === new URL(config.callbackUri).pathname) {
        const state = requiredQuery(url, "state");
        const transaction = transactions.getByState(state);
        const token = await exchangeTapdCode({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          code: requiredQuery(url, "code"),
          callbackUri: transaction.callbackUri,
        });
        transactions.complete(state, token);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end("<!doctype html><title>FlowRivet</title><p>授权完成，可以关闭此页面。</p>");
      }
      if (request.method === "POST" && url.pathname === "/oauth/redeem") {
        const input = await readJson(request);
        return json(
          response,
          200,
          transactions.redeem(
            stringField(input, "transactionId"),
            stringField(input, "codeVerifier"),
          ),
        );
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "request_failed" });
    }
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} is required`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === "string" && value ? value : undefined;
}

function requiredQuery(url: URL, key: string) {
  const value = url.searchParams.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

if (process.env.FLOWRIVET_START_OAUTH_BROKER === "true") {
  const config = loadBrokerConfig();
  createOAuthBroker(config).listen(config.port, "127.0.0.1");
}
