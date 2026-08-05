export interface BrokerConfig {
  clientId: string;
  clientSecret: string;
  callbackUri: string;
  scopes: string[];
  port: number;
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
  };
}

function required(environment: Record<string, string | undefined>, key: string) {
  const value = environment[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}
