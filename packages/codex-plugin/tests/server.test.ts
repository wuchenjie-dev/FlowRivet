import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { demoTaskboardSnapshot } from "../src/demo/fixtures.js";
import {
  createTaskboardMcpServer,
  TASKBOARD_RESOURCE_URI,
} from "../src/server/app.js";
import { createTaskboardHttpServer } from "../src/server/http.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createBundle(contents = "<html><body>FlowRivet</body></html>") {
  const directory = await mkdtemp(join(tmpdir(), "flowrivet-mcp-"));
  temporaryDirectories.push(directory);
  const bundlePath = join(directory, "taskboard.html");
  await writeFile(bundlePath, contents, "utf8");
  return bundlePath;
}

async function connectClient(uiBundlePath: string) {
  const server = createTaskboardMcpServer({ uiBundlePath });
  const client = new Client({ name: "flowrivet-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("taskboard MCP app", () => {
  it("lists the render and demo tools with UI metadata only on render", async () => {
    const connection = await connectClient(await createBundle());

    try {
      const { tools } = await connection.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["open_my_taskboard", "demo_ping"]),
      );

      const openTool = tools.find((tool) => tool.name === "open_my_taskboard");
      const pingTool = tools.find((tool) => tool.name === "demo_ping");
      expect(openTool?._meta?.ui).toEqual({ resourceUri: TASKBOARD_RESOURCE_URI });
      expect(pingTool?._meta?.ui).toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  it("returns the taskboard UI resource", async () => {
    const html = "<html><body>FlowRivet taskboard</body></html>";
    const connection = await connectClient(await createBundle(html));

    try {
      const resource = await connection.client.readResource({
        uri: TASKBOARD_RESOURCE_URI,
      });
      expect(resource.contents).toEqual([
        expect.objectContaining({
          uri: TASKBOARD_RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
        }),
      ]);
    } finally {
      await connection.close();
    }
  });

  it("returns structured board data and a working demo ping", async () => {
    const connection = await connectClient(await createBundle());

    try {
      const openResult = await connection.client.callTool({
        name: "open_my_taskboard",
        arguments: {},
      });
      const pingResult = await connection.client.callTool({
        name: "demo_ping",
        arguments: { message: "hello" },
      });

      expect(openResult.structuredContent).toEqual(demoTaskboardSnapshot);
      expect(pingResult.structuredContent).toMatchObject({
        ok: true,
        message: "hello",
      });
    } finally {
      await connection.close();
    }
  });

  it("reports the exact UI build command when the bundle is missing", async () => {
    const connection = await connectClient(join(tmpdir(), "missing-taskboard.html"));

    try {
      await expect(
        connection.client.readResource({ uri: TASKBOARD_RESOURCE_URI }),
      ).rejects.toThrow(
        "npm run build:ui --workspace @flowrivet/codex-plugin",
      );
    } finally {
      await connection.close();
    }
  });
});

describe("taskboard HTTP server", () => {
  it("serves health checks and rejects unknown routes", async () => {
    const server = createTaskboardHttpServer({
      uiBundlePath: await createBundle(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    try {
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const health = await fetch(`${baseUrl}/health`);
      const missing = await fetch(`${baseUrl}/missing`);

      await expect(health.json()).resolves.toEqual({ status: "ok" });
      expect(health.status).toBe(200);
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("allows loopback MCP preflight requests", async () => {
    const server = createTaskboardHttpServer({
      uiBundlePath: await createBundle(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:43120" },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:43120",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
