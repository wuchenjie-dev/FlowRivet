import {
  taskboardPreferencesSchema,
  type TaskboardPreferences,
} from "../contracts/taskboard-preferences.js";
import type { TaskboardPreferencesStore } from "./taskboard-preferences-store.js";

export class TaskboardPreferencesService {
  constructor(private readonly store: TaskboardPreferencesStore) {}

  get(): Promise<TaskboardPreferences> {
    return this.store.load();
  }

  async save(preferences: TaskboardPreferences): Promise<TaskboardPreferences> {
    const parsed = taskboardPreferencesSchema.parse(preferences);
    await this.store.save(parsed);
    return parsed;
  }
}
