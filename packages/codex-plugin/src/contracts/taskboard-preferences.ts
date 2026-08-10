import { z } from "zod";

export const refreshIntervalSecondsSchema = z.number().int().refine(
  (value) => value === 0 || (value >= 5 && value <= 3600),
  "refresh interval must be 0 or an integer from 5 to 3600 seconds",
);

export const taskboardPreferencesSchema = z.object({
  refreshIntervalSeconds: refreshIntervalSecondsSchema,
}).strict();

export type TaskboardPreferences = z.infer<typeof taskboardPreferencesSchema>;

export const defaultTaskboardPreferences: TaskboardPreferences = {
  refreshIntervalSeconds: 60,
};
