import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { executionRecordSchema, type ExecutionRecord } from "../contracts/executions.js";
import {
  ExecutionStoreError,
  type ExecutionIdentity,
  type ExecutionStore,
  type ExecutionStoreErrorCode,
} from "./execution-store.js";

const SCHEMA_VERSION = 1;
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
          execution_id, provider_id, account_key, work_item_key, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          parsed.executionId, parsed.providerId, parsed.accountKey, parsed.workItemKey,
          JSON.stringify(parsed), parsed.createdAt, parsed.updatedAt,
        );
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          throw new ExecutionStoreError("execution_already_exists");
        }
        throw error;
      }
    });
  }

  async find(identity: ExecutionIdentity) {
    return this.read((database) => this.parse(database.prepare(`
      SELECT payload_json FROM executions
      WHERE provider_id = ? AND account_key = ? AND work_item_key = ?
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
    try { return executionRecordSchema.parse(JSON.parse(row.payload_json)); }
    catch { throw new ExecutionStoreError("execution_store_read_failed"); }
  }
  private initialize(database: DatabaseSync) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("CREATE TABLE IF NOT EXISTS execution_schema(version INTEGER NOT NULL) STRICT");
      const version = database.prepare("SELECT version FROM execution_schema LIMIT 1").get() as { version: number } | undefined;
      if (!version) database.prepare("INSERT INTO execution_schema(version) VALUES (?)").run(SCHEMA_VERSION);
      else if (version.version !== SCHEMA_VERSION) throw new ExecutionStoreError("execution_store_read_failed");
      database.exec(`CREATE TABLE IF NOT EXISTS executions(
        execution_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, account_key TEXT NOT NULL,
        work_item_key TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE(provider_id, account_key, work_item_key)
      ) STRICT`);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
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
