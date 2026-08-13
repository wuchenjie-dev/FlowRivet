import { randomUUID } from "node:crypto";

import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  directoryPurposeSchema,
  directorySelectionInputSchema,
  directorySelectionSchema,
} from "../../contracts/directory-picker.js";
import {
  DirectoryPickerError,
  type DirectoryPicker,
  type DirectoryPurpose,
} from "../../local-directory/directory-picker.js";

export interface DirectoryPickerOperationEvent {
  requestId: string;
  tool: "select_local_directory";
  purpose: DirectoryPurpose;
  platform: NodeJS.Platform;
  outcome: "selected" | "cancelled" | "error";
  durationMs: number;
  errorCode?: string;
}

export interface DirectoryPickerOperationLogger {
  completed(event: DirectoryPickerOperationEvent): void;
}

export class JsonStderrDirectoryPickerOperationLogger
implements DirectoryPickerOperationLogger {
  completed(event: DirectoryPickerOperationEvent) {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  }
}

export function registerDirectoryPickerTools(server: McpServer, options: {
  picker: DirectoryPicker;
  logger?: DirectoryPickerOperationLogger;
  platform?: NodeJS.Platform;
  now?: () => Date;
  createRequestId?: () => string;
}) {
  const logger = options.logger ?? new JsonStderrDirectoryPickerOperationLogger();
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  const createRequestId = options.createRequestId ?? randomUUID;

  registerAppTool(server, "select_local_directory", {
    title: "选择本机文件夹",
    description: "在本机打开系统目录选择器，只返回用户主动选择的绝对路径。",
    inputSchema: {
      purpose: directoryPurposeSchema,
      initialDirectory: directorySelectionInputSchema.shape.initialDirectory,
    },
    outputSchema: {
      outcome: directorySelectionSchema.options[0].shape.outcome.or(
        directorySelectionSchema.options[1].shape.outcome,
      ),
      absolutePath: directorySelectionSchema.options[0].shape.absolutePath.optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {},
  }, async ({ purpose, initialDirectory }, extra) => {
    const requestId = createRequestId();
    const startedAt = now().getTime();
    try {
      const selection = directorySelectionSchema.parse(
        await options.picker.selectDirectory({
          purpose,
          ...(initialDirectory ? { initialDirectory } : {}),
          signal: extra.signal,
        }),
      );
      logger.completed({
        requestId,
        tool: "select_local_directory",
        purpose,
        platform,
        outcome: selection.outcome,
        durationMs: Math.max(0, now().getTime() - startedAt),
      });
      return { structuredContent: selection, content: [] };
    } catch (error) {
      const errorCode = error instanceof DirectoryPickerError
        ? error.code
        : "directory_picker_failed";
      logger.completed({
        requestId,
        tool: "select_local_directory",
        purpose,
        platform,
        outcome: "error",
        durationMs: Math.max(0, now().getTime() - startedAt),
        errorCode,
      });
      throw new Error(errorCode);
    }
  });
}
