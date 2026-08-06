import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function resolveRequestId(headers: IncomingHttpHeaders) {
  const value = headers["x-request-id"];
  return typeof value === "string" && REQUEST_ID.test(value) ? value : randomUUID();
}
