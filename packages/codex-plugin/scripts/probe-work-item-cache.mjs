import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { TapdIdentityClient } from "../dist/auth/tapd-identity-client.js";
import { SqliteWorkItemCacheStore } from "../dist/cache/sqlite-work-item-cache-store.js";
import { TapdProjectProvider } from "../dist/projects/tapd-project-provider.js";
import { TapdWorkItemProvider } from "../dist/work-items/tapd-work-item-provider.js";
import { WorkItemService } from "../dist/work-items/work-item-service.js";

let databasePath;

try {
  databasePath = temporaryDatabasePath(process.argv.slice(2));
  const token = process.env.TAPD_TOKEN?.trim();
  if (!token) throw probeError("tapd_token_missing");

  const identity = await new TapdIdentityClient().validate(token);
  if (!identity.accountKey) throw probeError("cache_identity_unavailable");
  const credentialResolver = {
    resolve: async () => ({ token, accountDisplayName: identity.userName }),
  };
  const projects = await new TapdProjectProvider({ credentialResolver }).discoverProjects();
  const firstProject = projects[0];
  if (!firstProject) throw probeError("no_accessible_project");

  const now = new Date();
  const project = {
    providerId: "tapd",
    externalId: firstProject.externalId,
    name: firstProject.name,
    ...(firstProject.prettyName ? { prettyName: firstProject.prettyName } : {}),
    selected: true,
    available: true,
    source: "discovered",
    lastVerifiedAt: now.toISOString(),
  };
  const provider = new TapdWorkItemProvider({ credentialResolver });
  const firstStore = new SqliteWorkItemCacheStore({
    path: databasePath,
    DatabaseSync,
  });
  const live = await new WorkItemService(provider, () => now, firstStore).sync({
    accountDisplayName: identity.userName,
    cacheAccount: {
      providerId: "tapd",
      accountKey: identity.accountKey,
      ...(identity.companyId ? { tenantKey: identity.companyId } : {}),
      accountDisplayName: identity.userName,
      ...(identity.companyName ? { tenantDisplayName: identity.companyName } : {}),
    },
    projects: [project],
  });

  const secondStore = new SqliteWorkItemCacheStore({
    path: databasePath,
    DatabaseSync,
  });
  const offline = await new WorkItemService(provider, () => now, secondStore)
    .loadCached("tapd");
  const requiredFieldsPresent = Boolean(offline)
    && offline.projects.length === 1
    && offline.items.every((item) => [
      item.key,
      item.providerId,
      item.externalId,
      item.projectExternalId,
      item.providerItemType,
      item.title,
      item.stage,
      item.providerStatus,
      item.externalUrl,
    ].every((value) => typeof value === "string" && value.length > 0));
  const result = {
    ok: Boolean(offline)
      && offline.dataFreshness === "offline"
      && live.freshScopeCount > 0
      && offline.staleScopeCount === live.freshScopeCount
      && requiredFieldsPresent,
    cacheHit: Boolean(offline),
    dataFreshness: offline?.dataFreshness ?? "live",
    scopeCount: offline?.staleScopeCount ?? 0,
    requiredFieldsPresent,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    errorCode: error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "probe_failed",
  })}\n`);
  process.exitCode = 1;
} finally {
  if (databasePath) {
    await Promise.all(["", "-journal", "-shm", "-wal"].map((suffix) =>
      rm(`${databasePath}${suffix}`, { force: true })));
  }
}

function temporaryDatabasePath(args) {
  const index = args.indexOf("--db");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw probeError("temporary_db_path_required");
  const candidate = resolve(value);
  const temporaryDirectory = realpathSync.native(resolve(tmpdir()));
  const candidateDirectory = realpathSync.native(dirname(candidate));
  if (candidateDirectory.toLowerCase() !== temporaryDirectory.toLowerCase()) {
    throw probeError("invalid_temporary_db_path");
  }
  return join(temporaryDirectory, basename(candidate));
}

function probeError(code) {
  return Object.assign(new Error(code), { code });
}
