import { createHash } from "node:crypto";
import pino, { type DestinationStream, type Logger } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type AppLogger = Logger;

export function createLogger(level: LogLevel, destination?: DestinationStream) {
  return pino(
    {
      level,
      redact: {
        paths: [
          "accessToken",
          "access_token",
          "clientSecret",
          "client_secret",
          "authorization",
          "headers.authorization",
          "code",
          "state",
          "codeVerifier",
          "codeChallenge",
          "authorizationUrl",
          "body",
          "url",
        ],
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}

export function transactionRef(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}
