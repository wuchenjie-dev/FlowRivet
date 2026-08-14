import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { projectRefSchema, type ProjectRef } from "../contracts/projects.js";
import {
  workItemSchema,
  type WorkItem,
  type WorkItemKind,
} from "../contracts/taskboard.js";
import {
  WorkItemCacheError,
  type CacheAccount,
  type CacheMergeInput,
  type CachedScope,
  type CachedSnapshot,
  type WorkItemCacheErrorCode,
  type WorkItemCacheStore,
} from "./work-item-cache-store.js";
import {
  isScopeDeletedByInventory,
  normalizeAuthoritativeScopeInventories,
} from "./merge-work-item-snapshot.js";

const SCHEMA_VERSION = 1;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const persistedWorkItemSchema = workItemSchema.omit({ freshness: true });

type DatabaseSyncConstructor = typeof import("node:sqlite").DatabaseSync;

interface AccountRow {
  provider_id: string;
  account_display_name: string;
  tenant_display_name: string | null;
}

interface NamespaceRow {
  namespace_key: string;
}

interface ProjectRow {
  project_json: string;
}

interface ScopeRow {
  project_external_id: string;
  provider_item_type: string;
  kind: string;
  last_success_at: string;
}

interface ItemRow {
  project_external_id: string;
  provider_item_type: string;
  item_json: string;
}

export class SqliteWorkItemCacheStore implements WorkItemCacheStore {
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
      throw cacheError(error, "cache_read_failed");
    }
  }

  async activateAccount(input: CacheAccount): Promise<void> {
    this.writeTransaction("cache_write_failed", (database) => {
      this.activate(database, input);
    });
  }

  async mergeScopes(input: CacheMergeInput): Promise<CachedSnapshot> {
    return this.writeTransaction("cache_write_failed", (database) => {
      const authoritativeScopeInventories = normalizeAuthoritativeScopeInventories(
        input.authoritativeScopeInventories,
      );
      const namespaceKey = this.activate(database, input.account);
      if (input.authoritativeProjects) {
        this.pruneProjects(database, namespaceKey, input.projects);
      } else if (input.authoritativeProjectScopePrefixes?.length) {
        this.pruneProjectScopes(
          database,
          namespaceKey,
          input.projects,
          input.authoritativeProjectScopePrefixes,
        );
      }
      if (input.authoritativeProviderItemTypes?.length) {
        this.pruneProviderItemTypes(
          database,
          namespaceKey,
          input.scopes,
          input.authoritativeProviderItemTypes,
        );
      }
      const projects = new Map(input.projects.map((project) => [project.externalId, project]));
      const freshScopeKeys = new Set<string>();
      let hasSuccess = false;

      for (const authoritative of input.authoritativeScopePrefixes ?? []) {
        if (authoritativeScopeInventories.some((inventory) =>
          inventory.projectExternalId === authoritative.projectExternalId
            && inventory.providerItemTypePrefix === authoritative.providerItemTypePrefix)) {
          continue;
        }
        const retainedTypes = new Set(input.scopes
          .filter((scope) => scope.projectExternalId === authoritative.projectExternalId
            && scope.providerItemType.startsWith(authoritative.providerItemTypePrefix))
          .map((scope) => scope.providerItemType));
        const rows = database.prepare(`
          SELECT provider_item_type FROM cache_scopes
          WHERE namespace_key = ? AND project_external_id = ?
        `).all(namespaceKey, authoritative.projectExternalId) as unknown as Array<{
          provider_item_type: string;
        }>;
        for (const row of rows) {
          if (!row.provider_item_type.startsWith(authoritative.providerItemTypePrefix)
            || retainedTypes.has(row.provider_item_type)) continue;
          database.prepare(`
            DELETE FROM cache_scopes
            WHERE namespace_key = ? AND project_external_id = ? AND provider_item_type = ?
          `).run(namespaceKey, authoritative.projectExternalId, row.provider_item_type);
        }
      }
      if (input.authoritativeScopePrefixes?.length) {
        this.deleteProjectsWithoutScopes(database, namespaceKey);
      }

      if (authoritativeScopeInventories.length > 0) {
        const rows = database.prepare(`
          SELECT project_external_id, provider_item_type FROM cache_scopes
          WHERE namespace_key = ?
        `).all(namespaceKey) as unknown as Array<{
          project_external_id: string;
          provider_item_type: string;
        }>;
        for (const row of rows) {
          if (!isScopeDeletedByInventory({
            projectExternalId: row.project_external_id,
            providerItemType: row.provider_item_type,
          }, authoritativeScopeInventories)) continue;
          database.prepare(`
            DELETE FROM cache_scopes
            WHERE namespace_key = ? AND project_external_id = ? AND provider_item_type = ?
          `).run(namespaceKey, row.project_external_id, row.provider_item_type);
        }
        this.deleteProjectsWithoutScopes(database, namespaceKey);
      }

      for (const scope of input.scopes) {
        if (scope.outcome !== "success"
          || isScopeDeletedByInventory(scope, authoritativeScopeInventories, {
            allowCatalogSentinel: true,
          })) continue;
        const project = projects.get(scope.projectExternalId);
        if (!project) throw new WorkItemCacheError("cache_write_failed");
        hasSuccess = true;
        freshScopeKeys.add(scopeKey(scope.projectExternalId, scope.providerItemType));
        const parsedProject = projectRefSchema.parse(project);
        database.prepare(`
          INSERT INTO cache_projects(namespace_key, project_external_id, project_json)
          VALUES (?, ?, ?)
          ON CONFLICT(namespace_key, project_external_id)
          DO UPDATE SET project_json = excluded.project_json
        `).run(namespaceKey, project.externalId, JSON.stringify(parsedProject));
        database.prepare(`
          DELETE FROM cache_items
          WHERE namespace_key = ? AND project_external_id = ? AND provider_item_type = ?
        `).run(namespaceKey, scope.projectExternalId, scope.providerItemType);
        database.prepare(`
          INSERT INTO cache_scopes(
            namespace_key, project_external_id, provider_item_type, kind, last_success_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(namespace_key, project_external_id, provider_item_type)
          DO UPDATE SET kind = excluded.kind, last_success_at = excluded.last_success_at
        `).run(
          namespaceKey,
          scope.projectExternalId,
          scope.providerItemType,
          scope.kind,
          input.now.toISOString(),
        );
        for (const value of scope.items) {
          const parsed = workItemSchema.parse(value);
          if (parsed.providerId !== input.account.providerId
            || parsed.projectExternalId !== scope.projectExternalId
            || parsed.kind !== scope.kind) {
            throw new WorkItemCacheError("cache_write_failed");
          }
          const { freshness: _freshness, ...persisted } = parsed;
          database.prepare(`
            INSERT INTO cache_items(
              namespace_key, project_external_id, provider_item_type, item_key, item_json
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            namespaceKey,
            scope.projectExternalId,
            scope.providerItemType,
            parsed.key,
            JSON.stringify(persistedWorkItemSchema.parse(persisted)),
          );
        }
      }

      if (hasSuccess) {
        database.prepare(`
          UPDATE cache_accounts SET last_success_at = ? WHERE namespace_key = ?
        `).run(input.now.toISOString(), namespaceKey);
      }
      this.purgeExpiredInDatabase(database, input.now);
      return this.readSnapshot(database, namespaceKey, freshScopeKeys)
        ?? emptySnapshot(input.account);
    });
  }

  async loadAccount(
    account: CacheAccount,
    now: Date,
  ): Promise<CachedSnapshot | undefined> {
    try {
      const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
      return this.withDatabase((database) =>
        this.readSnapshot(database, namespaceFor(account), new Set(), cutoff));
    } catch (error) {
      throw cacheError(error, "cache_read_failed");
    }
  }

  async loadActive(
    providerId: string,
    now: Date,
  ): Promise<CachedSnapshot | undefined> {
    return this.writeTransaction("cache_read_failed", (database) => {
      this.purgeExpiredInDatabase(database, now);
      const active = database.prepare(`
        SELECT namespace_key FROM cache_accounts
        WHERE provider_id = ? AND is_active = 1
      `).get(providerId) as NamespaceRow | undefined;
      return active
        ? this.readSnapshot(database, active.namespace_key, new Set())
        : undefined;
    });
  }

  async clearActive(providerId: string): Promise<void> {
    this.writeTransaction("cache_clear_failed", (database) => {
      database.prepare(
        "DELETE FROM cache_accounts WHERE provider_id = ? AND is_active = 1",
      ).run(providerId);
    });
  }

  async purgeExpired(now: Date): Promise<number> {
    return this.writeTransaction("cache_write_failed", (database) =>
      this.purgeExpiredInDatabase(database, now));
  }

  private activate(database: DatabaseSync, account: CacheAccount) {
    const namespaceKey = namespaceFor(account);
    database.prepare(`
      DELETE FROM cache_accounts
      WHERE provider_id = ? AND namespace_key <> ?
    `).run(account.providerId, namespaceKey);
    database.prepare(`
      INSERT INTO cache_accounts(
        namespace_key, provider_id, account_display_name, tenant_display_name,
        last_success_at, is_active
      ) VALUES (?, ?, ?, ?, NULL, 1)
      ON CONFLICT(namespace_key) DO UPDATE SET
        account_display_name = excluded.account_display_name,
        tenant_display_name = excluded.tenant_display_name,
        is_active = 1
    `).run(
      namespaceKey,
      account.providerId,
      account.accountDisplayName,
      account.tenantDisplayName ?? null,
    );
    return namespaceKey;
  }

  private pruneProjects(
    database: DatabaseSync,
    namespaceKey: string,
    projects: ProjectRef[],
  ) {
    if (projects.length === 0) {
      database.prepare("DELETE FROM cache_projects WHERE namespace_key = ?")
        .run(namespaceKey);
      return;
    }
    const placeholders = projects.map(() => "?").join(", ");
    database.prepare(`
      DELETE FROM cache_projects
      WHERE namespace_key = ? AND project_external_id NOT IN (${placeholders})
    `).run(namespaceKey, ...projects.map((project) => project.externalId));
  }

  private pruneProjectScopes(
    database: DatabaseSync,
    namespaceKey: string,
    projects: ProjectRef[],
    providerItemTypePrefixes: string[],
  ) {
    const availableProjectIds = new Set(projects.map((project) => project.externalId));
    const rows = database.prepare(`
      SELECT project_external_id, provider_item_type FROM cache_scopes
      WHERE namespace_key = ?
    `).all(namespaceKey) as unknown as Array<{
      project_external_id: string;
      provider_item_type: string;
    }>;
    for (const row of rows) {
      if (availableProjectIds.has(row.project_external_id)
        || !providerItemTypePrefixes.some((prefix) => row.provider_item_type.startsWith(prefix))) {
        continue;
      }
      database.prepare(`
        DELETE FROM cache_scopes
        WHERE namespace_key = ? AND project_external_id = ? AND provider_item_type = ?
      `).run(namespaceKey, row.project_external_id, row.provider_item_type);
    }
    this.deleteProjectsWithoutScopes(database, namespaceKey);
  }

  private pruneProviderItemTypes(
    database: DatabaseSync,
    namespaceKey: string,
    scopes: CacheMergeInput["scopes"],
    providerItemTypes: string[],
  ) {
    const authoritativeTypes = new Set(providerItemTypes);
    const retainedScopeKeys = new Set(scopes
      .filter((scope) => scope.outcome === "success"
        && authoritativeTypes.has(scope.providerItemType))
      .map((scope) => scopeKey(scope.projectExternalId, scope.providerItemType)));
    const rows = database.prepare(`
      SELECT project_external_id, provider_item_type FROM cache_scopes
      WHERE namespace_key = ?
    `).all(namespaceKey) as unknown as Array<{
      project_external_id: string;
      provider_item_type: string;
    }>;
    for (const row of rows) {
      if (!authoritativeTypes.has(row.provider_item_type)
        || retainedScopeKeys.has(scopeKey(row.project_external_id, row.provider_item_type))) {
        continue;
      }
      database.prepare(`
        DELETE FROM cache_scopes
        WHERE namespace_key = ? AND project_external_id = ? AND provider_item_type = ?
      `).run(namespaceKey, row.project_external_id, row.provider_item_type);
    }
    this.deleteProjectsWithoutScopes(database, namespaceKey);
  }

  private deleteProjectsWithoutScopes(database: DatabaseSync, namespaceKey: string) {
    database.prepare(`
      DELETE FROM cache_projects
      WHERE namespace_key = ? AND NOT EXISTS (
        SELECT 1 FROM cache_scopes
        WHERE cache_scopes.namespace_key = cache_projects.namespace_key
          AND cache_scopes.project_external_id = cache_projects.project_external_id
      )
    `).run(namespaceKey);
  }

  private purgeExpiredInDatabase(database: DatabaseSync, now: Date) {
    const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
    const result = database.prepare(
      "DELETE FROM cache_scopes WHERE last_success_at < ?",
    ).run(cutoff);
    database.exec(`
      DELETE FROM cache_projects
      WHERE NOT EXISTS (
        SELECT 1 FROM cache_scopes
        WHERE cache_scopes.namespace_key = cache_projects.namespace_key
          AND cache_scopes.project_external_id = cache_projects.project_external_id
      );
      DELETE FROM cache_accounts
      WHERE NOT EXISTS (
        SELECT 1 FROM cache_scopes
        WHERE cache_scopes.namespace_key = cache_accounts.namespace_key
      );
    `);
    return Number(result.changes);
  }

  private readSnapshot(
    database: DatabaseSync,
    namespaceKey: string,
    freshScopeKeys: Set<string>,
    minimumLastSuccessAt?: string,
  ): CachedSnapshot | undefined {
    try {
      const account = database.prepare(`
        SELECT provider_id, account_display_name, tenant_display_name
        FROM cache_accounts
        WHERE namespace_key = ?
      `).get(namespaceKey) as AccountRow | undefined;
      if (!account) return undefined;

      const scopeRows = database.prepare(`
        SELECT project_external_id, provider_item_type, kind, last_success_at
        FROM cache_scopes
        WHERE namespace_key = ?
          ${minimumLastSuccessAt ? "AND last_success_at >= ?" : ""}
        ORDER BY project_external_id, provider_item_type
      `).all(
        namespaceKey,
        ...(minimumLastSuccessAt ? [minimumLastSuccessAt] : []),
      ) as unknown as ScopeRow[];
      if (scopeRows.length === 0) return undefined;

      const retainedProjectIds = [...new Set(scopeRows.map((row) => row.project_external_id))];
      const projectPlaceholders = retainedProjectIds.map(() => "?").join(", ");

      const projectRows = database.prepare(`
        SELECT project_json FROM cache_projects
        WHERE namespace_key = ?
          AND project_external_id IN (${projectPlaceholders})
        ORDER BY project_external_id
      `).all(namespaceKey, ...retainedProjectIds) as unknown as ProjectRow[];
      const itemRows = database.prepare(`
        SELECT project_external_id, provider_item_type, item_json
        FROM cache_items
        WHERE namespace_key = ?
        ORDER BY project_external_id, provider_item_type, item_key
      `).all(namespaceKey) as unknown as ItemRow[];

      const itemsByScope = new Map<string, WorkItem[]>();
      for (const row of itemRows) {
        const key = scopeKey(row.project_external_id, row.provider_item_type);
        const parsed = persistedWorkItemSchema.parse(JSON.parse(row.item_json));
        const freshness = freshScopeKeys.has(key) ? "fresh" : "cached";
        const items = itemsByScope.get(key) ?? [];
        items.push(workItemSchema.parse({ ...parsed, freshness }));
        itemsByScope.set(key, items);
      }

      const scopes: CachedScope[] = scopeRows.map((row) => {
        const key = scopeKey(row.project_external_id, row.provider_item_type);
        return {
          projectExternalId: row.project_external_id,
          providerItemType: row.provider_item_type,
          kind: parseKind(row.kind),
          freshness: freshScopeKeys.has(key) ? "fresh" : "cached",
          lastSuccessfulSyncAt: row.last_success_at,
          items: itemsByScope.get(key) ?? [],
        };
      });
      const lastSuccessfulSyncAt = scopes.reduce<string | undefined>(
        (latest, scope) => !latest || scope.lastSuccessfulSyncAt > latest
          ? scope.lastSuccessfulSyncAt
          : latest,
        undefined,
      );
      return {
        account: {
          providerId: account.provider_id,
          accountDisplayName: account.account_display_name,
          ...(account.tenant_display_name
            ? { tenantDisplayName: account.tenant_display_name }
            : {}),
        },
        projects: projectRows.map((row) =>
          projectRefSchema.parse(JSON.parse(row.project_json))),
        scopes,
        items: scopes.flatMap((scope) => scope.items),
        ...(lastSuccessfulSyncAt ? { lastSuccessfulSyncAt } : {}),
      };
    } catch (error) {
      throw cacheError(error, "cache_read_failed");
    }
  }

  private initialize(database: DatabaseSync) {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS cache_schema(
          version INTEGER NOT NULL
        ) STRICT;
      `);
      const version = database.prepare("SELECT version FROM cache_schema LIMIT 1")
        .get() as { version: number } | undefined;
      if (!version) {
        database.prepare("INSERT INTO cache_schema(version) VALUES (?)").run(SCHEMA_VERSION);
      } else if (Number(version.version) !== SCHEMA_VERSION) {
        throw new WorkItemCacheError("cache_read_failed");
      }
      database.exec(`
      CREATE TABLE IF NOT EXISTS cache_accounts(
        namespace_key TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        account_display_name TEXT NOT NULL,
        tenant_display_name TEXT,
        last_success_at TEXT,
        is_active INTEGER NOT NULL CHECK(is_active IN (0, 1))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_cache_account_per_provider
      ON cache_accounts(provider_id) WHERE is_active = 1;

      CREATE TABLE IF NOT EXISTS cache_projects(
        namespace_key TEXT NOT NULL,
        project_external_id TEXT NOT NULL,
        project_json TEXT NOT NULL,
        PRIMARY KEY(namespace_key, project_external_id),
        FOREIGN KEY(namespace_key) REFERENCES cache_accounts(namespace_key)
          ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS cache_scopes(
        namespace_key TEXT NOT NULL,
        project_external_id TEXT NOT NULL,
        provider_item_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        last_success_at TEXT NOT NULL,
        PRIMARY KEY(namespace_key, project_external_id, provider_item_type),
        FOREIGN KEY(namespace_key, project_external_id)
          REFERENCES cache_projects(namespace_key, project_external_id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS cache_items(
        namespace_key TEXT NOT NULL,
        project_external_id TEXT NOT NULL,
        provider_item_type TEXT NOT NULL,
        item_key TEXT NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY(namespace_key, project_external_id, provider_item_type, item_key),
        FOREIGN KEY(namespace_key, project_external_id, provider_item_type)
          REFERENCES cache_scopes(namespace_key, project_external_id, provider_item_type)
          ON DELETE CASCADE
      ) STRICT;
      `);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the initialization failure.
      }
      throw error;
    }
  }

  private writeTransaction<T>(
    code: WorkItemCacheErrorCode,
    operation: (database: DatabaseSync) => T,
  ): T {
    try {
      return this.withDatabase((database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = operation(database);
          database.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // Preserve the original stable cache error.
          }
          throw error;
        }
      });
    } catch (error) {
      throw cacheError(error, code);
    }
  }

  private withDatabase<T>(operation: (database: DatabaseSync) => T): T {
    const database = new this.DatabaseSync(this.path);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      return operation(database);
    } finally {
      database.close();
    }
  }
}

function namespaceFor(account: CacheAccount) {
  return createHash("sha256").update(JSON.stringify([
    account.providerId,
    account.tenantKey ?? "",
    account.accountKey,
  ])).digest("hex");
}

function scopeKey(projectExternalId: string, providerItemType: string) {
  return `${projectExternalId}\u0000${providerItemType}`;
}

function parseKind(value: string): WorkItemKind {
  if (["requirement", "task", "defect", "other"].includes(value)) {
    return value as WorkItemKind;
  }
  throw new WorkItemCacheError("cache_read_failed");
}

function emptySnapshot(account: CacheAccount): CachedSnapshot {
  return {
    account: {
      providerId: account.providerId,
      accountDisplayName: account.accountDisplayName,
      ...(account.tenantDisplayName
        ? { tenantDisplayName: account.tenantDisplayName }
        : {}),
    },
    projects: [],
    scopes: [],
    items: [],
  };
}

function cacheError(
  error: unknown,
  fallback: WorkItemCacheErrorCode,
): WorkItemCacheError {
  return error instanceof WorkItemCacheError
    ? error
    : new WorkItemCacheError(fallback);
}
