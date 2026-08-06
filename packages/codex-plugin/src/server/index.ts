import { createTaskboardHttpServer } from "./http.js";

const host = process.env.FLOWRIVET_MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.FLOWRIVET_MCP_PORT ?? "43120");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("FLOWRIVET_MCP_PORT must be an integer between 1 and 65535");
}

const server = createTaskboardHttpServer();

server.listen(port, host, () => {
  console.log(`FlowRivet Companion listening on http://${host}:${port}/mcp`);
});
