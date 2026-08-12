import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveFlowRivetConfigDirectory } from "../projects/json-project-selection-store.js";
import { SqliteExecutionStore } from "./sqlite-execution-store.js";

export function createExecutionStore(directory = resolveFlowRivetConfigDirectory()) {
  return new SqliteExecutionStore({
    path: join(directory, "executions.db"),
    DatabaseSync,
  });
}
