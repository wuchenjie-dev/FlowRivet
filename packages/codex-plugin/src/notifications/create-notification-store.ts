import { join } from "node:path";

import { resolveFlowRivetConfigDirectory } from "../projects/json-project-selection-store.js";
import { SqliteNotificationStore } from "./sqlite-notification-store.js";

export async function createNotificationStore(
  directory = resolveFlowRivetConfigDirectory(),
) {
  const { DatabaseSync } = await import("node:sqlite");
  return new SqliteNotificationStore({
    path: join(directory, "notifications.db"),
    DatabaseSync,
  });
}
