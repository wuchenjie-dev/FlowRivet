import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { TaskboardMcpServerOptions } from "./app.js";
import { createTaskboardRuntime } from "./taskboard-runtime.js";
import {
  COMPANION_PRODUCT,
  type CompanionHealth,
} from "./companion-instance.js";

const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);

export function isLoopbackHost(host: string) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized === "::1";
}

export function assertLoopbackHost(host: string) {
  if (!isLoopbackHost(host)) {
    throw new Error("FLOWRIVET_MCP_HOST must be a loopback host");
  }
}

function isLoopbackOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function applyCors(origin: string | undefined, response: import("node:http").ServerResponse) {
  if (origin && isLoopbackOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

export function createTaskboardHttpServer(
  options: TaskboardMcpServerOptions & { companionHealth?: CompanionHealth } = {},
) {
  const {
    companionHealth = {
      product: COMPANION_PRODUCT,
      pid: process.pid,
      instanceId: randomUUID(),
    },
    ...runtimeOptions
  } = options;
  const runtime = createTaskboardRuntime(runtimeOptions);
  return createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );

    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok", ...companionHealth }));
      return;
    }

    if (url.pathname !== "/mcp") {
      response.writeHead(404).end("Not Found");
      return;
    }

    const origin = request.headers.origin;
    if (origin && !isLoopbackOrigin(origin)) {
      response.writeHead(403).end("Origin is not allowed");
      return;
    }

    applyCors(origin, response);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      });
      response.end();
      return;
    }

    if (!request.method || !MCP_METHODS.has(request.method)) {
      response.writeHead(405, { Allow: "POST, GET, DELETE, OPTIONS" }).end();
      return;
    }

    const server = runtime.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Internal MCP server error" }));
      }
    }
  });
}
