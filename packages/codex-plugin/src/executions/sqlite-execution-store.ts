import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { executionRecordSchema, type ExecutionRecord } from "../contracts/executions.js";
import { parsePersistedExecutionRecord } from "./execution-record-migration.js";
import {
  ExecutionStoreError,
  type ExecutionIdentity,
  type ExecutionStore,
  type ExecutionStoreErrorCode,
} from "./execution-store.js";

const SCHEMA_VERSION = 2;
type DatabaseSyncConstructor = typeof import("node:sqlite").DatabaseSync;
interface ExecutionRow { payload_json: string }

export class SqliteExecutionStore implements ExecutionStore {
  private readonly path: string;
  private readonly DatabaseSync: DatabaseSyncConstructor;

  constructor(options: { path: string; DatabaseSync: DatabaseSyncConstructor; platform?: NodeJS.Platform }) {
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
      throw storeError(error, "execution_store_read_failed");
    }
  }

  async create(record: ExecutionRecord) {
    const parsed = executionRecordSchema.parse(record);
    this.write((database) => {
      try {
        database.prepare(`INSERT INTO executions(
          execution_id, provider_id, account_key, work_item_key, attempt, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          parsed.executionId, parsed.providerId, parsed.accountKey, parsed.workItemKey,
          parsed.attempt, JSON.stringify(parsed), parsed.createdAt, parsed.updatedAt,
        );
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          throw new ExecutionStoreError("execution_already_exists");
        }
        throw error;
      }
    });
  }

  async findCurrent(identity: ExecutionIdentity) {
    return this.read((database) => this.parse(database.prepare(`
      SELECT payload_json FROM executions
      WHERE provider_id = ? AND account_key = ? AND work_item_key = ?
        AND json_extract(payload_json, '$.state') <> 'completed'
      ORDER BY attempt DESC LIMIT 1
    `).get(identity.providerId, identity.accountKey, identity.workItemKey) as ExecutionRow | undefined));
  }

  async findLatest(identity: ExecutionIdentity) {
    return this.read((database) => this.parse(database.prepare(`
      SELECT payload_json FROM executions
      WHERE provider_id = ? AND account_key = ? AND work_item_key = ?
      ORDER BY attempt DESC LIMIT 1
    `).get(identity.providerId, identity.accountKey, identity.workItemKey) as ExecutionRow | undefined));
  }

  async getById(executionId: string) {
    return this.read((database) => this.parse(database.prepare(
      "SELECT payload_json FROM executions WHERE execution_id = ?",
    ).get(executionId) as ExecutionRow | undefined));
  }

  async save(record: ExecutionRecord) {
    const parsed = executionRecordSchema.parse(record);
    this.write((database) => {
      const result = database.prepare(`UPDATE executions SET payload_json = ?, updated_at = ?
        WHERE execution_id = ?`).run(JSON.stringify(parsed), parsed.updatedAt, parsed.executionId);
      if (Number(result.changes) !== 1) throw new ExecutionStoreError("execution_not_found");
    });
  }

  private parse(row: ExecutionRow | undefined) {
    if (!row) return undefined;
    try { return parsePersistedExecutionRecord(JSON.parse(row.payload_json)); }
    catch { throw new ExecutionStoreError("execution_store_read_failed"); }
  }
  private initialize(database: DatabaseSync) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("CREATE TABLE IF NOT EXISTS execution_schema(version INTEGER NOT NULL) STRICT");
      const version = database.prepare("SELECT version FROM execution_schema LIMIT 1").get() as { version: number } | undefined;
      if (!version) {
        database.prepare("INSERT INTO execution_schema(version) VALUES (?)").run(SCHEMA_VERSION);
        this.createVersionTwoTable(database);
      } else if (version.version === 1) {
        this.migrateVersionOne(database);
      } else if (version.version === SCHEMA_VERSION) {
        this.createVersionTwoTable(database);
      } else {
        throw new ExecutionStoreError("execution_store_read_failed");
      }
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  private createVersionTwoTable(database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS executions(
      execution_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, account_key TEXT NOT NULL,
      work_item_key TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0),
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(provider_id, account_key, work_item_key, attempt)
    ) STRICT`);
  }
  private migrateVersionOne(database: DatabaseSync) {
    database.exec(`CREATE TABLE executions_v2(
      execution_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, account_key TEXT NOT NULL,
      work_item_key TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0),
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(provider_id, account_key, work_item_key, attempt)
    ) STRICT`);
    const rows = database.prepare("SELECT * FROM executions").all() as Array<{
      execution_id: string; provider_id: string; account_key: string; work_item_key: string;
      payload_json: string; created_at: string; updated_at: string;
    }>;
    const insert = database.prepare(`INSERT INTO executions_v2(
      execution_id, provider_id, account_key, work_item_key, attempt, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      const migrated = parsePersistedExecutionRecord(JSON.parse(row.payload_json));
      insert.run(row.execution_id, row.provider_id, row.account_key, row.work_item_key,
        migrated.attempt, JSON.stringify(migrated), row.created_at, row.updated_at);
    }
    const copied = database.prepare("SELECT COUNT(*) AS count FROM executions_v2").get() as { count: number };
    if (Number(copied.count) !== rows.length) throw new ExecutionStoreError("execution_store_write_failed");
    database.exec("DROP TABLE executions");
    database.exec("ALTER TABLE executions_v2 RENAME TO executions");
    database.prepare("UPDATE execution_schema SET version = ?").run(SCHEMA_VERSION);
  }
  private read<T>(operation: (database: DatabaseSync) => T) {
    try { return this.withDatabase(operation); }
    catch (error) { throw storeError(error, "execution_store_read_failed"); }
  }
  private write<T>(operation: (database: DatabaseSync) => T) {
    return this.read((database) => {
      database.exec("BEGIN IMMEDIATE");
      try { const result = operation(database); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    });
  }
  private withDatabase<T>(operation: (database: DatabaseSync) => T): T {
    const database = new this.DatabaseSync(this.path);
    try { database.exec("PRAGMA busy_timeout = 5000"); return operation(database); }
    finally { database.close(); }
  }
}

function storeError(error: unknown, fallback: ExecutionStoreErrorCode) {
  return error instanceof ExecutionStoreError ? error : new ExecutionStoreError(fallback);
}
