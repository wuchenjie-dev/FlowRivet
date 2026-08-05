export function buildAuthorizationUrl(input: {
  clientId: string;
  callbackUri: string;
  state: string;
  scopes: string[];
}) {
  const url = new URL("https://www.tapd.cn/oauth/");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.callbackUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("auth_by", "user");
  url.searchParams.set("state", input.state);
  return url.toString();
}

const sensitiveKeys = new Set([
  "access_token",
  "authorization",
  "client_secret",
  "code",
  "refresh_token",
  "state",
  "token",
]);

export function redactOAuthData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOAuthData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeys.has(key.toLowerCase()) ? "[REDACTED]" : redactOAuthData(item),
    ]),
  );
}
