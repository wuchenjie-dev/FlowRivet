import { randomUUID } from "node:crypto";

import {
  assertLoopbackHost,
  createTaskboardHttpServer,
} from "./http.js";
import {
  COMPANION_PRODUCT,
  removeCompanionInstance,
  resolveCompanionInstancePath,
  writeCompanionInstance,
  type CompanionInstance,
} from "./companion-instance.js";
import { resolveRuntimeVersion } from "../contracts/runtime-version.js";

const host = process.env.FLOWRIVET_MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.FLOWRIVET_MCP_PORT ?? "43120");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("FLOWRIVET_MCP_PORT must be an integer between 1 and 65535");
}
assertLoopbackHost(host);

const instanceId = randomUUID();
const startedAt = new Date().toISOString();
const instancePath = resolveCompanionInstancePath();
const runtimeVersion = resolveRuntimeVersion();
const health = {
  product: COMPANION_PRODUCT,
  pid: process.pid,
  instanceId,
  runtimeVersion: runtimeVersion.version,
  protocolVersion: runtimeVersion.protocolVersion,
  uiVersion: runtimeVersion.uiVersion,
} as const;
const server = createTaskboardHttpServer({ companionHealth: health });

server.listen(port, host, () => {
  const instance: CompanionInstance = {
    version: 1,
    ...health,
    processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
    host,
    port,
    startedAt,
  };
  void writeCompanionInstance(instancePath, instance)
    .then(() => {
      console.log(`FlowRivet Companion listening on http://${host}:${port}/mcp`);
    })
    .catch((error) => {
      console.error(`FlowRivet Companion failed to write its instance file: ${String(error)}`);
      server.close(() => {
        process.exitCode = 1;
      });
    });
});

server.once("close", () => {
  void removeCompanionInstance(instancePath, health);
});

for (const signal of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
  process.once(signal, () => {
    server.close(() => {
      process.exitCode = 0;
    });
  });
}
