import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { DirectoryPicker } from "../src/local-directory/directory-picker.js";
import { DirectoryPickerError } from "../src/local-directory/directory-picker.js";
import {
  registerDirectoryPickerTools,
  type DirectoryPickerOperationLogger,
} from "../src/server/tools/directory-picker-tools.js";

async function connect(options: {
  picker: DirectoryPicker;
  logger?: DirectoryPickerOperationLogger;
  platform?: NodeJS.Platform;
}) {
  const server = new McpServer({ name: "directory-picker-test", version: "0.1.0" });
  registerDirectoryPickerTools(server, options);
  const client = new Client({ name: "directory-picker-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => { await client.close(); await server.close(); },
  };
}

describe("directory picker MCP tool", () => {
  it("registers a read-only, closed-world tool with a bounded purpose", async () => {
    const connection = await connect({
      picker: { selectDirectory: vi.fn().mockResolvedValue({ outcome: "cancelled" }) },
    });
    try {
      const tool = (await connection.client.listTools()).tools
        .find((entry) => entry.name === "select_local_directory");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
        "purpose", "initialDirectory",
      ]);
      expect(tool?.inputSchema.properties?.purpose).toMatchObject({
        enum: ["existing_repository", "clone_parent"],
      });
    } finally { await connection.close(); }
  });

  it("returns selected and cancelled outcomes and forwards the request signal", async () => {
    const selectDirectory = vi.fn<DirectoryPicker["selectDirectory"]>()
      .mockResolvedValueOnce({ outcome: "selected", absolutePath: "C:\\workspace\\example" })
      .mockResolvedValueOnce({ outcome: "cancelled" });
    const connection = await connect({ picker: { selectDirectory } });
    try {
      const selected = await connection.client.callTool({
        name: "select_local_directory",
        arguments: {
          purpose: "existing_repository",
          initialDirectory: "C:\\workspace\\example",
        },
      });
      const cancelled = await connection.client.callTool({
        name: "select_local_directory",
        arguments: { purpose: "clone_parent" },
      });
      expect(selected.structuredContent).toEqual({
        outcome: "selected", absolutePath: "C:\\workspace\\example",
      });
      expect(cancelled.structuredContent).toEqual({ outcome: "cancelled" });
      expect(selectDirectory).toHaveBeenNthCalledWith(1, {
        purpose: "existing_repository",
        initialDirectory: "C:\\workspace\\example",
        signal: expect.any(AbortSignal),
      });
    } finally { await connection.close(); }
  });

  it("returns stable errors and logs no selected path", async () => {
    const events: Parameters<DirectoryPickerOperationLogger["completed"]>[0][] = [];
    const logger: DirectoryPickerOperationLogger = { completed: (event) => events.push(event) };
    const picker: DirectoryPicker = {
      selectDirectory: vi.fn()
        .mockResolvedValueOnce({ outcome: "selected", absolutePath: "C:\\private\\workspace" })
        .mockRejectedValueOnce(new DirectoryPickerError("directory_picker_busy")),
    };
    const connection = await connect({ picker, logger, platform: "win32" });
    try {
      await connection.client.callTool({
        name: "select_local_directory", arguments: { purpose: "existing_repository" },
      });
      const failed = await connection.client.callTool({
        name: "select_local_directory", arguments: { purpose: "clone_parent" },
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).toContain("directory_picker_busy");
      expect(events).toEqual([
        expect.objectContaining({
          requestId: expect.any(String), purpose: "existing_repository", platform: "win32",
          outcome: "selected", durationMs: expect.any(Number),
        }),
        expect.objectContaining({
          requestId: expect.any(String), purpose: "clone_parent", platform: "win32",
          outcome: "error", errorCode: "directory_picker_busy", durationMs: expect.any(Number),
        }),
      ]);
      expect(JSON.stringify(events)).not.toMatch(/C:\\\\private|workspace/i);
      expect(JSON.stringify(events)).not.toContain("initialDirectory");
    } finally { await connection.close(); }
  });

  it("rejects unknown purposes before invoking the picker", async () => {
    const selectDirectory = vi.fn<DirectoryPicker["selectDirectory"]>();
    const connection = await connect({ picker: { selectDirectory } });
    try {
      const result = await connection.client.callTool({
        name: "select_local_directory",
        arguments: { purpose: "arbitrary", path: "C:\\secret" },
      });
      expect(result.isError).toBe(true);
      expect(selectDirectory).not.toHaveBeenCalled();
    } finally { await connection.close(); }
  });
});
