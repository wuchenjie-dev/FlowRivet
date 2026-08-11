import type {
  ProviderLoginErrorCode,
  ProviderLoginState,
} from "../contracts/providers.js";

export type ProviderLoginToolName =
  | "start_provider_login"
  | "get_provider_login"
  | "reopen_provider_login"
  | "cancel_provider_login"
  | "provider_login_poll";

export interface ProviderLoginOperationEvent {
  requestId: string;
  correlationId: string;
  tool: ProviderLoginToolName;
  providerId: string;
  fromState?: ProviderLoginState;
  toState?: ProviderLoginState;
  outcome: "success" | "error";
  errorCode?: ProviderLoginErrorCode;
  durationMs: number;
  retryCount?: number;
}

export interface ProviderLoginOperationLogger {
  log(event: ProviderLoginOperationEvent): void;
}

export class JsonStderrProviderLoginOperationLogger
implements ProviderLoginOperationLogger {
  constructor(
    private readonly write: (line: string) => unknown = (line) => process.stderr.write(line),
  ) {}

  log(event: ProviderLoginOperationEvent): void {
    const safe = {
      requestId: event.requestId,
      correlationId: event.correlationId,
      tool: event.tool,
      providerId: event.providerId,
      ...(event.fromState ? { fromState: event.fromState } : {}),
      ...(event.toState ? { toState: event.toState } : {}),
      outcome: event.outcome,
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      durationMs: event.durationMs,
      ...(event.retryCount !== undefined ? { retryCount: event.retryCount } : {}),
    };
    this.write(`${JSON.stringify(safe)}\n`);
  }
}
