import type { LogLevel } from "./logging.js";

export interface BrokerConfig {
  clientId: string;
  clientSecret: string;
  callbackUri: string;
  scopes: string[];
  port: number;
  logLevel: LogLevel;
}

export function loadBrokerConfig(
  environment: Record<string, string | undefined> = process.env,
): BrokerConfig {
  const clientId = required(environment, "TAPD_OAUTH_CLIENT_ID");
  const clientSecret = required(environment, "TAPD_OAUTH_CLIENT_SECRET");
  const callbackUri = required(environment, "FLOWRIVET_OAUTH_CALLBACK_URI");
  const parsed = new URL(callbackUri);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") {
    throw new Error("OAuth callback must use HTTPS except for 127.0.0.1 development");
  }
  return {
    clientId,
    clientSecret,
    callbackUri,
    scopes: (environment.FLOWRIVET_TAPD_SCOPES ?? "story#read workspace#read")
      .split(/\s+/)
      .filter(Boolean),
    port: Number(environment.PORT ?? "43119"),
    logLevel: parseLogLevel(environment.FLOWRIVET_LOG_LEVEL),
  };
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value ?? "info";
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    return level;
  }
  throw new Error("FLOWRIVET_LOG_LEVEL must be debug, info, warn, or error");
}

function required(environment: Record<string, string | undefined>, key: string) {
  const value = environment[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}
