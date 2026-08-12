import { createHash } from "node:crypto";

export interface UpdateSchedulerOptions {
  check: () => Promise<unknown> | unknown;
  installationId: string;
  baseIntervalMs?: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class UpdateScheduler {
  private current?: Promise<void>;
  private timer?: unknown;
  private failures = 0;
  private stopped = false;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: UpdateSchedulerOptions) {
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  start(): Promise<void> {
    this.stopped = false;
    return this.checkNow();
  }

  checkNow(): Promise<void> {
    if (this.current) return this.current;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    let checkResult: Promise<unknown>;
    try {
      checkResult = Promise.resolve(this.options.check());
    } catch (error) {
      checkResult = Promise.reject(error);
    }
    this.current = checkResult
      .then(() => { this.failures = 0; })
      .catch(() => { this.failures += 1; })
      .then(() => { if (!this.stopped) this.arm(); })
      .finally(() => { this.current = undefined; });
    return this.current;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    const base = this.options.baseIntervalMs ?? 30 * 60_000;
    const backoff = Math.min(8, 2 ** this.failures);
    const jitter = installationJitter(this.options.installationId);
    const delay = Math.round(base * backoff * jitter);
    this.timer = this.schedule(() => { void this.checkNow(); }, delay);
  }
}

function installationJitter(installationId: string): number {
  const byte = createHash("sha256").update(installationId).digest()[0]!;
  return 0.9 + (byte / 255) * 0.2;
}
