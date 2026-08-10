import type { TaskboardPreferences } from "../contracts/taskboard-preferences.js";

export interface TaskboardPreferencesStore {
  load(): Promise<TaskboardPreferences>;
  save(preferences: TaskboardPreferences): Promise<void>;
}

export type TaskboardPreferencesStoreErrorCode =
  | "taskboard_preferences_read_failed"
  | "taskboard_preferences_write_failed";

export class TaskboardPreferencesStoreError extends Error {
  constructor(readonly code: TaskboardPreferencesStoreErrorCode) {
    super(code);
    this.name = "TaskboardPreferencesStoreError";
  }
}
