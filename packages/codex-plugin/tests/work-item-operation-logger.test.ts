import { describe, expect, it, vi } from "vitest";

import {
  JsonStderrWorkItemOperationLogger,
  type WorkItemOperationEvent,
} from "../src/observability/work-item-operation-logger.js";

describe("work item operation logger", () => {
  it("serializes only approved aggregate fields and exact cache diagnostics", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = new JsonStderrWorkItemOperationLogger();
    const event = {
      requestId: "request-1",
      tool: "refresh_my_work_items",
      providerId: "feishu-project",
      outcome: "success",
      durationMs: 12,
      successfulProjects: 2,
      failedProjects: 0,
      itemCount: 4,
      cacheDiagnosticCodes: ["cache_read_failed", "cache_write_failed"],
      token: "must-not-leak",
      accountKey: "must-not-leak",
    } as WorkItemOperationEvent & Record<string, unknown>;

    logger.completed(event);

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      requestId: "request-1",
      tool: "refresh_my_work_items",
      providerId: "feishu-project",
      outcome: "success",
      durationMs: 12,
      successfulProjects: 2,
      failedProjects: 0,
      itemCount: 4,
      cacheDiagnosticCodes: ["cache_read_failed", "cache_write_failed"],
    });
    write.mockRestore();
  });
});
