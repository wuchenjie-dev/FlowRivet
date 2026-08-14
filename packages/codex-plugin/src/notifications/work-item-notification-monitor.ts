import type { ProviderAuthService } from "../providers/provider-auth-service.js";
import type { WorkItemSynchronizer } from "../work-items/work-item-service.js";
import { detectWorkItemNotificationChanges } from "./notification-diff-engine.js";
import type { NotificationStore } from "./notification-store.js";
import type { SystemNotifier } from "./system-notifier.js";

interface MonitorIdentity {
  profileName?: string;
  accountKey: string;
  accountDisplayName: string;
  tenantKey?: string;
  tenantDisplayName?: string;
}

interface MonitorProvider {
  auth: Pick<ProviderAuthService, "getConnection"> & {
    getSessionIdentity?(): MonitorIdentity | undefined;
  };
  synchronizer: Pick<WorkItemSynchronizer, "sync">;
}

export class WorkItemNotificationMonitor {
  private readonly activeProvider: () => Promise<string>;
  private readonly resolveProvider: (providerId: string) => MonitorProvider;
  private readonly store: NotificationStore;
  private readonly notifier: SystemNotifier;
  private readonly clock: () => Date;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private running = false;

  constructor(options: {
    activeProvider: () => Promise<string>;
    resolveProvider: (providerId: string) => MonitorProvider;
    store: NotificationStore;
    notifier: SystemNotifier;
    clock?: () => Date;
    intervalSeconds?: number;
  }) {
    this.activeProvider = options.activeProvider;
    this.resolveProvider = options.resolveProvider;
    this.store = options.store;
    this.notifier = options.notifier;
    this.clock = options.clock ?? (() => new Date());
    this.intervalMs = (options.intervalSeconds ?? 60) * 1_000;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const operation = this.scan();
    const shared = operation.finally(() => {
      if (this.inFlight === shared) this.inFlight = undefined;
    });
    this.inFlight = shared;
    return shared;
  }

  private async scan() {
    const providerId = await this.activeProvider();
    const provider = this.resolveProvider(providerId);
    const connection = await provider.auth.getConnection();
    if (connection.state !== "connected") return;
    const identity = provider.auth.getSessionIdentity?.();
    if (!identity?.accountKey) return;
    const account = { providerId, accountKey: identity.accountKey };
    const now = this.clock();
    const snapshot = await provider.synchronizer.sync({
      accountDisplayName: identity.accountDisplayName,
      projects: [],
      refreshMode: "automatic",
      ...(identity.profileName ? { syncSessionKey: identity.profileName } : {}),
      cacheAccount: {
        providerId,
        accountKey: identity.accountKey,
        ...(identity.tenantKey ? { tenantKey: identity.tenantKey } : {}),
        accountDisplayName: identity.accountDisplayName,
        ...(identity.tenantDisplayName
          ? { tenantDisplayName: identity.tenantDisplayName }
          : {}),
      },
    });
    const previous = await this.store.loadBaseline(account);
    const diff = detectWorkItemNotificationChanges({
      previous,
      items: snapshot.items,
      now,
    });
    const inserted = await this.store.applyScan({
      account,
      baseline: diff.next,
      events: diff.events,
      now,
    });
    for (const event of inserted) {
      try {
        await this.notifier.notify({
          title: event.title,
          message: event.message,
          ...(event.externalUrl ? { externalUrl: event.externalUrl } : {}),
        });
      } catch {
        // The durable inbox remains authoritative when native notifications fail.
      }
    }
  }

  private schedule() {
    this.timer = setTimeout(() => {
      void this.runOnce().catch(() => undefined).finally(() => {
        if (this.running) this.schedule();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }
}

export function parseNotificationInterval(value: string | undefined) {
  if (value === undefined || value === "") return 60;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3_600) {
    throw new Error(
      "FLOWRIVET_NOTIFICATION_INTERVAL_SECONDS must be an integer between 30 and 3600",
    );
  }
  return seconds;
}
