import { describe, expect, it, vi } from "vitest";

import { JsonStderrProviderLoginOperationLogger } from "../src/observability/provider-login-operation-logger.js";

describe("provider login operation logger", () => {
  it("writes only approved login metadata", () => {
    const write = vi.fn();
    const logger = new JsonStderrProviderLoginOperationLogger(write);

    logger.log({
      requestId: "request-1",
      correlationId: "correlation-1",
      tool: "start_provider_login",
      providerId: "feishu-project",
      fromState: "starting",
      toState: "waiting",
      outcome: "success",
      durationMs: 12,
      retryCount: 0,
      deviceCode: "DEVICE-SECRET",
      stdout: "SENSITIVE STDOUT",
      profileName: "private-profile",
    } as never);

    expect(write).toHaveBeenCalledOnce();
    const output = String(write.mock.calls[0]![0]);
    expect(JSON.parse(output)).toEqual({
      requestId: "request-1",
      correlationId: "correlation-1",
      tool: "start_provider_login",
      providerId: "feishu-project",
      fromState: "starting",
      toState: "waiting",
      outcome: "success",
      durationMs: 12,
      retryCount: 0,
    });
    expect(output).not.toMatch(/DEVICE-SECRET|SENSITIVE STDOUT|private-profile/u);
  });
});
