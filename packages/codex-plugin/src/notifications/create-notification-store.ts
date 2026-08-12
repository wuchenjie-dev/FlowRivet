import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveFlowRivetConfigDirectory } from "../projects/json-project-selection-store.js";
import { SqliteNotificationStore } from "./sqlite-notification-store.js";

export function createNotificationStore(
  directory = resolveFlowRivetConfigDirectory(),
) {
  return new SqliteNotificationStore({
    path: join(directory, "notifications.db"),
    DatabaseSync,
  });
}
