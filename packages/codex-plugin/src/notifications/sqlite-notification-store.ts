import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  workItemNotificationListSchema,
  workItemNotificationSchema,
  type WorkItemNotification,
} from "../contracts/notifications.js";
import type { NotificationItemBaseline, WorkItemNotificationCandidate } from "./notification-diff-engine.js";
import {
  NotificationStoreError,
  type NotificationAccount,
  type NotificationStore,
  type NotificationStoreErrorCode,
  type WorkItemNotificationCandidateWithId,
} from "./notification-store.js";

const SCHEMA_VERSION = 1;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
type DatabaseSyncConstructor = typeof import("node:sqlite").DatabaseSync;

interface BaselineRow { item_json: string }
interface EventRow {
  id: string;
  provider_id: string;
  work_item_key: string;
  type: WorkItemNotification["type"];
  title: string;
  project_name: string;
  message: string;
  occurred_at: string;
  read_at: string | null;
  external_url: string | null;
}

export class SqliteNotificationStore implements NotificationStore {
  private readonly path: string;
  private readonly DatabaseSync: DatabaseSyncConstructor;

  constructor(options: {
    path: string;
    DatabaseSync: DatabaseSyncConstructor;
    platform?: NodeJS.Platform;
  }) {
    this.path = options.path;
    this.DatabaseSync = options.DatabaseSync;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.withDatabase((database) => this.initialize(database));
      if ((options.platform ?? process.platform) !== "win32") {
        chmodSync(dirname(this.path), 0o700);
        chmodSync(this.path, 0o600);
      }
    } catch (error) {
      throw storeError(error, "notification_store_read_failed");
    }
  }

  async loadBaseline(account: NotificationAccount) {
    return this.read("notification_store_read_failed", (database) => {
      const namespace = namespaceFor(account);
      const exists = database.prepare(
        "SELECT 1 AS found FROM notification_accounts WHERE namespace_key = ?",
      ).get(namespace) as { found: number } | undefined;
      if (!exists) return undefined;
      const rows = database.prepare(`
        SELECT item_json FROM notification_items
        WHERE namespace_key = ? ORDER BY work_item_key
      `).all(namespace) as unknown as BaselineRow[];
      return rows.map((row) => JSON.parse(row.item_json) as NotificationItemBaseline);
    });
  }

  async applyScan(input: {
    account: NotificationAccount;
    baseline: NotificationItemBaseline[];
    events: WorkItemNotificationCandidate[];
    now: Date;
  }): Promise<WorkItemNotificationCandidateWithId[]> {
    return this.write("notification_store_write_failed", (database) => {
      const namespace = namespaceFor(input.account);
      this.upsertAccount(database, namespace, input.account, input.now);
      this.purge(database, input.now);
      const inserted: WorkItemNotificationCandidateWithId[] = [];
      for (const event of input.events) {
        const id = randomUUID();
        const dedupeKey = digest(`${namespace}\u0000${event.dedupeMaterial}`);
        const result = database.prepare(`
          INSERT INTO notification_events(
            id, namespace_key, provider_id, work_item_key, type, title,
            project_name, message, occurred_at, read_at, external_url, dedupe_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(dedupe_key) DO NOTHING
        `).run(
          id, namespace, event.providerId, event.workItemKey, event.type,
          event.title, event.projectName, event.message, event.occurredAt,
          event.externalUrl ?? null, dedupeKey,
        );
        if (Number(result.changes) === 1) inserted.push({ ...event, id });
      }

      database.prepare("DELETE FROM notification_items WHERE namespace_key = ?")
        .run(namespace);
      const insertBaseline = database.prepare(`
        INSERT INTO notification_items(namespace_key, work_item_key, item_json)
        VALUES (?, ?, ?)
      `);
      for (const entry of input.baseline) {
        insertBaseline.run(namespace, entry.workItemKey, JSON.stringify(entry));
      }
      return inserted;
    });
  }

  async list(
    account: NotificationAccount,
    options: { now: Date; unreadOnly?: boolean },
  ) {
    return this.write("notification_store_read_failed", (database) => {
      this.purge(database, options.now);
      const namespace = namespaceFor(account);
      const where = options.unreadOnly ? "AND read_at IS NULL" : "";
      const rows = database.prepare(`
        SELECT id, provider_id, work_item_key, type, title, project_name,
               message, occurred_at, read_at, external_url
        FROM notification_events
        WHERE namespace_key = ? ${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT 500
      `).all(namespace) as unknown as EventRow[];
      const unread = database.prepare(`
        SELECT COUNT(*) AS count FROM notification_events
        WHERE namespace_key = ? AND read_at IS NULL
      `).get(namespace) as { count: number };
      return workItemNotificationListSchema.parse({
        notifications: rows.map(rowToNotification),
        unreadCount: Number(unread.count),
      });
    });
  }

  async markRead(account: NotificationAccount, id: string, now: Date) {
    this.write("notification_store_write_failed", (database) => {
      database.prepare(`
        UPDATE notification_events SET read_at = COALESCE(read_at, ?)
        WHERE namespace_key = ? AND id = ?
      `).run(now.toISOString(), namespaceFor(account), id);
    });
  }

  async markAllRead(account: NotificationAccount, now: Date) {
    this.write("notification_store_write_failed", (database) => {
      database.prepare(`
        UPDATE notification_events SET read_at = ?
        WHERE namespace_key = ? AND read_at IS NULL
      `).run(now.toISOString(), namespaceFor(account));
    });
  }

  private initialize(database: DatabaseSync) {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS notification_schema(version INTEGER NOT NULL) STRICT;
      `);
      const version = database.prepare("SELECT version FROM notification_schema LIMIT 1")
        .get() as { version: number } | undefined;
      if (!version) {
        database.prepare("INSERT INTO notification_schema(version) VALUES (?)")
          .run(SCHEMA_VERSION);
      } else if (version.version !== SCHEMA_VERSION) {
        throw new NotificationStoreError("notification_store_read_failed");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS notification_accounts(
          namespace_key TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          last_scan_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS notification_items(
          namespace_key TEXT NOT NULL REFERENCES notification_accounts(namespace_key) ON DELETE CASCADE,
          work_item_key TEXT NOT NULL,
          item_json TEXT NOT NULL,
          PRIMARY KEY(namespace_key, work_item_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS notification_events(
          id TEXT PRIMARY KEY,
          namespace_key TEXT NOT NULL REFERENCES notification_accounts(namespace_key) ON DELETE CASCADE,
          provider_id TEXT NOT NULL,
          work_item_key TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('assigned', 'status_changed', 'schedule_changed', 'due_soon', 'overdue')),
          title TEXT NOT NULL,
          project_name TEXT NOT NULL,
          message TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          read_at TEXT,
          external_url TEXT,
          dedupe_key TEXT NOT NULL UNIQUE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS notification_events_inbox
        ON notification_events(namespace_key, occurred_at DESC);
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertAccount(
    database: DatabaseSync,
    namespace: string,
    account: NotificationAccount,
    now: Date,
  ) {
    database.prepare(`
      INSERT INTO notification_accounts(namespace_key, provider_id, last_scan_at)
      VALUES (?, ?, ?)
      ON CONFLICT(namespace_key) DO UPDATE SET last_scan_at = excluded.last_scan_at
    `).run(namespace, account.providerId, now.toISOString());
  }

  private purge(database: DatabaseSync, now: Date) {
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
    database.prepare("DELETE FROM notification_events WHERE occurred_at < ?").run(cutoff);
  }

  private read<T>(code: NotificationStoreErrorCode, operation: (database: DatabaseSync) => T) {
    try {
      return this.withDatabase(operation);
    } catch (error) {
      throw storeError(error, code);
    }
  }

  private write<T>(code: NotificationStoreErrorCode, operation: (database: DatabaseSync) => T) {
    return this.read(code, (database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(database);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  private withDatabase<T>(operation: (database: DatabaseSync) => T): T {
    const database = new this.DatabaseSync(this.path);
    try {
      database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
      return operation(database);
    } finally {
      database.close();
    }
  }
}

function namespaceFor(account: NotificationAccount) {
  return digest(`${account.providerId}\u0000${account.accountKey}`);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function rowToNotification(row: EventRow): WorkItemNotification {
  return workItemNotificationSchema.parse({
    id: row.id,
    providerId: row.provider_id,
    workItemKey: row.work_item_key,
    type: row.type,
    title: row.title,
    projectName: row.project_name,
    message: row.message,
    occurredAt: row.occurred_at,
    ...(row.read_at ? { readAt: row.read_at } : {}),
    ...(row.external_url ? { externalUrl: row.external_url } : {}),
  });
}

function storeError(error: unknown, fallback: NotificationStoreErrorCode) {
  return error instanceof NotificationStoreError ? error : new NotificationStoreError(fallback);
}
