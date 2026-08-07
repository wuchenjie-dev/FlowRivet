import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TapdAuthenticator } from "../src/auth/tapd-auth-service.js";
import type { ProjectCatalogResult } from "../src/contracts/projects.js";
import type { ProjectOperationLogger } from "../src/observability/project-operation-logger.js";
import type { WorkItemOperationLogger } from "../src/observability/work-item-operation-logger.js";
import type { ProjectCatalog } from "../src/projects/project-catalog-service.js";
import {
  createTaskboardMcpServer,
  TASKBOARD_RESOURCE_URI,
} from "../src/server/app.js";
import { createTaskboardHttpServer } from "../src/server/http.js";
import type { WorkItemSynchronizer } from "../src/work-items/work-item-service.js";

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

function authenticator(
  tapd: "connected" | "disconnected" | "expired" = "connected",
): TapdAuthenticator {
  const connection = tapd === "connected"
    ? { tapd, userName: "吴晨杰", companyName: "FlowRivet 演示企业" } as const
    : { tapd } as const;
  return {
    login: async () => ({ ok: true, connection: {
      tapd: "connected",
      userName: "吴晨杰",
      companyName: "FlowRivet 测试企业",
    } }),
    getConnectionStatus: async () => ({ ok: true, connection }),
    disconnect: async () => ({ ok: true, connection: { tapd: "disconnected" } }),
  };
}

async function connectClient(
  uiBundlePath: string,
  authService: TapdAuthenticator = authenticator(),
  projectCatalog: ProjectCatalog = catalog().service,
  projectLogger?: ProjectOperationLogger,
  workItemService: WorkItemSynchronizer = synchronizer().service,
  workItemLogger?: WorkItemOperationLogger,
) {
  const server = createTaskboardMcpServer({
    uiBundlePath,
    authService,
    projectCatalog,
    ...(projectLogger ? { projectLogger } : {}),
    workItemService,
    ...(workItemLogger ? { workItemLogger } : {}),
  });
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

function catalog(projects: ProjectCatalogResult["projects"] = []) {
  const result: ProjectCatalogResult = {
    provider: {
      providerId: "tapd",
      displayName: "TAPD",
      state: "connected",
      accountDisplayName: "吴晨杰",
    },
    projects,
    stale: false,
  };
  const service: ProjectCatalog = {
    getCatalog: vi.fn().mockResolvedValue(result),
    discover: vi.fn().mockResolvedValue(result),
    saveSelection: vi.fn().mockResolvedValue(result),
    addProject: vi.fn().mockResolvedValue(result),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  return { result, service };
}

function project(externalId: string, selected = true) {
  return {
    providerId: "tapd",
    externalId,
    name: `Project ${externalId}`,
    selected,
    available: true,
    source: "discovered" as const,
    lastVerifiedAt: "2026-08-07T00:00:00.000Z",
  };
}

function synchronizer(projects: ProjectCatalogResult["projects"] = []) {
  const items = projects.map((entry, index) => ({
    key: `tapd:${entry.externalId}:task:${index + 1}`,
    providerId: "tapd",
    externalId: String(index + 1),
    projectExternalId: entry.externalId,
    projectName: entry.name,
    kind: "task" as const,
    providerItemType: "task",
    title: `Work ${index + 1}`,
    stage: "todo" as const,
    providerStatus: "open",
    externalUrl: `https://example.test/work/${index + 1}`,
  }));
  const result = {
    items,
    projects: projects.map((entry) => ({ ...entry, count: 1 })),
    summary: {
      successfulProjects: projects.length,
      failedProjects: 0,
      itemCount: items.length,
    },
  };
  const service: WorkItemSynchronizer = { sync: vi.fn().mockResolvedValue(result) };
  return { result, service };
}

describe("taskboard MCP app", () => {
  it("lists the render and demo tools with UI metadata only on render", async () => {
    const connection = await connectClient(await createBundle());

    try {
      const { tools } = await connection.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "open_my_taskboard",
          "list_my_work_items",
          "refresh_my_work_items",
          "demo_ping",
          "get_connection_status",
          "login_with_tapd_token",
          "disconnect_tapd",
          "discover_projects",
          "save_project_selection",
          "add_project",
        ]),
      );

      const openTool = tools.find((tool) => tool.name === "open_my_taskboard");
      const pingTool = tools.find((tool) => tool.name === "demo_ping");
      expect(openTool?._meta?.ui).toEqual({ resourceUri: TASKBOARD_RESOURCE_URI });
      expect(pingTool?._meta?.ui).toBeUndefined();
      for (const name of ["discover_projects", "save_project_selection", "add_project"]) {
        expect(tools.find((tool) => tool.name === name)?._meta?.ui).toBeUndefined();
      }
    } finally {
      await connection.close();
    }
  });

  it("calls project catalog tools and returns provider-neutral catalogs", async () => {
    const fixture = catalog([project("50396062")]);
    const connection = await connectClient(
      await createBundle(),
      authenticator(),
      fixture.service,
    );

    try {
      const discovered = await connection.client.callTool({
        name: "discover_projects",
        arguments: { providerId: "tapd" },
      });
      const saved = await connection.client.callTool({
        name: "save_project_selection",
        arguments: { providerId: "tapd", externalIds: ["50396062"] },
      });
      const added = await connection.client.callTool({
        name: "add_project",
        arguments: { providerId: "tapd", input: "https://www.tapd.cn/50396062" },
      });

      expect(discovered.structuredContent).toEqual(fixture.result);
      expect(saved.structuredContent).toEqual(fixture.result);
      expect(added.structuredContent).toEqual(fixture.result);
      expect(fixture.service.discover).toHaveBeenCalledOnce();
      expect(fixture.service.saveSelection).toHaveBeenCalledWith(["50396062"]);
      expect(fixture.service.addProject).toHaveBeenCalledWith("https://www.tapd.cn/50396062");
    } finally {
      await connection.close();
    }
  });

  it("discovers all projects and returns real provider work items", async () => {
    const fixture = catalog([project("50396062"), project("56536239", false)]);
    const workItems = synchronizer(fixture.result.projects);
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined, workItems.service,
    );

    try {
      const result = await connection.client.callTool({
        name: "open_my_taskboard",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        readOnly: true,
        projects: [
          { externalId: "50396062", count: 1 },
          { externalId: "56536239", count: 1 },
        ],
        items: [
          { providerId: "tapd", projectExternalId: "50396062" },
          { providerId: "tapd", projectExternalId: "56536239" },
        ],
      });
      expect(fixture.service.discover).toHaveBeenCalledOnce();
      expect(fixture.service.getCatalog).not.toHaveBeenCalled();
      expect(workItems.service.sync).toHaveBeenCalledWith({
        accountDisplayName: "吴晨杰",
        projects: fixture.result.projects,
      });
    } finally {
      await connection.close();
    }
  });

  it("returns the same provider-neutral snapshot from list and refresh tools", async () => {
    const fixture = catalog([project("50396062")]);
    const workItems = synchronizer(fixture.result.projects);
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined, workItems.service,
    );

    try {
      for (const name of ["list_my_work_items", "refresh_my_work_items"]) {
        const result = await connection.client.callTool({ name, arguments: {} });
        expect(result.structuredContent).toMatchObject({
          readOnly: true,
          items: [{ providerId: "tapd", externalId: "1" }],
          syncSummary: { successfulProjects: 1, failedProjects: 0, itemCount: 1 },
        });
      }
    } finally {
      await connection.close();
    }
  });

  it("logs only aggregate work item operation data", async () => {
    const fixture = catalog([project("sensitive-project-id")]);
    const workItems = synchronizer(fixture.result.projects);
    const events: Parameters<WorkItemOperationLogger["completed"]>[0][] = [];
    const logger: WorkItemOperationLogger = { completed: (event) => events.push(event) };
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, undefined,
      workItems.service, logger,
    );

    try {
      await connection.client.callTool({ name: "open_my_taskboard", arguments: {} });
      expect(events).toEqual([expect.objectContaining({
        requestId: expect.any(String),
        tool: "open_my_taskboard",
        providerId: "tapd",
        outcome: "success",
        successfulProjects: 1,
        failedProjects: 0,
        itemCount: 1,
      })]);
      expect(JSON.stringify(events)).not.toMatch(
        /sensitive-project-id|Project sensitive-project-id|Work 1|吴晨杰|example\.test/,
      );
    } finally {
      await connection.close();
    }
  });

  it("clears the project catalog on disconnect and account switch", async () => {
    const fixture = catalog([project("50396062")]);
    const status = vi.fn()
      .mockResolvedValueOnce({ ok: true, connection: {
        tapd: "connected", userName: "old-user", companyName: "old-company",
      } })
      .mockResolvedValue({ ok: true, connection: {
        tapd: "connected", userName: "new-user", companyName: "new-company",
      } });
    const authService: TapdAuthenticator = {
      ...authenticator(),
      getConnectionStatus: status,
      login: vi.fn().mockResolvedValue({ ok: true, connection: {
        tapd: "connected", userName: "new-user", companyName: "new-company",
      } }),
    };
    const connection = await connectClient(await createBundle(), authService, fixture.service);

    try {
      await connection.client.callTool({
        name: "login_with_tapd_token",
        arguments: { token: "private-token" },
      });
      await connection.client.callTool({ name: "disconnect_tapd", arguments: {} });
      expect(fixture.service.clear).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });

  it("logs one sanitized completion event per project operation", async () => {
    const fixture = catalog([project("sensitive-project-id")]);
    const events: Parameters<ProjectOperationLogger["completed"]>[0][] = [];
    const logger: ProjectOperationLogger = { completed: (event) => events.push(event) };
    const connection = await connectClient(
      await createBundle(), authenticator(), fixture.service, logger,
    );

    try {
      await connection.client.callTool({
        name: "discover_projects",
        arguments: { providerId: "tapd" },
      });
      await connection.client.callTool({
        name: "save_project_selection",
        arguments: { providerId: "tapd", externalIds: ["sensitive-project-id"] },
      });
      await connection.client.callTool({
        name: "add_project",
        arguments: { providerId: "tapd", input: "https://secret.example/sensitive-project-id" },
      });
      expect(events).toHaveLength(3);
      expect(events.map((event) => event.tool)).toEqual([
        "discover_projects",
        "save_project_selection",
        "add_project",
      ]);
      expect(events).toEqual(events.map((event) => expect.objectContaining({
        requestId: expect.any(String),
        providerId: "tapd",
        outcome: "success",
        durationMs: expect.any(Number),
      })));
      const serialized = JSON.stringify(events);
      expect(serialized).not.toMatch(/secret|sensitive-project-id|吴晨杰|Project/);
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

  it("returns an empty unconfigured board and a working demo ping", async () => {
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

      expect(openResult.structuredContent).toMatchObject({
        connection: { tapd: "connected" },
        projectCatalog: { projects: [], stale: false },
        projects: [],
        items: [],
      });
      expect(pingResult.structuredContent).toMatchObject({
        ok: true,
        message: "hello",
      });
    } finally {
      await connection.close();
    }
  });

  it("returns an empty workspace when TAPD is disconnected", async () => {
    const connection = await connectClient(
      await createBundle(),
      authenticator("disconnected"),
    );

    try {
      const result = await connection.client.callTool({
        name: "open_my_taskboard",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        connection: { tapd: "disconnected" },
        projects: [],
        items: [],
      });
    } finally {
      await connection.close();
    }
  });

  it("logs in without returning the submitted token", async () => {
    const login = vi.fn().mockResolvedValue({
      ok: true,
      connection: {
        tapd: "connected",
        userName: "吴晨杰",
        companyName: "FlowRivet 测试企业",
      },
    });
    const authService = { ...authenticator("disconnected"), login };
    const connection = await connectClient(await createBundle(), authService);
    const token = "sensitive-personal-token";

    try {
      const result = await connection.client.callTool({
        name: "login_with_tapd_token",
        arguments: { token },
      });
      expect(login).toHaveBeenCalledWith(token);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        connection: { tapd: "connected", userName: "吴晨杰" },
      });
      expect(JSON.stringify(result)).not.toContain(token);
    } finally {
      await connection.close();
    }
  });

  it("returns connection status and disconnects without UI metadata", async () => {
    const disconnect = vi.fn().mockResolvedValue({
      ok: true,
      connection: { tapd: "disconnected" },
    });
    const authService = { ...authenticator(), disconnect };
    const connection = await connectClient(await createBundle(), authService);

    try {
      const status = await connection.client.callTool({
        name: "get_connection_status",
        arguments: {},
      });
      const disconnected = await connection.client.callTool({
        name: "disconnect_tapd",
        arguments: {},
      });
      expect(status.structuredContent).toMatchObject({
        connection: { tapd: "connected" },
      });
      expect(disconnected.structuredContent).toMatchObject({
        connection: { tapd: "disconnected" },
      });
      expect(disconnect).toHaveBeenCalledOnce();
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
