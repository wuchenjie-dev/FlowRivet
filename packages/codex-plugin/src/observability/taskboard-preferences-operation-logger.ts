export type TaskboardPreferencesToolName =
  | "get_taskboard_preferences"
  | "save_taskboard_preferences";

export interface TaskboardPreferencesOperationEvent {
  requestId: string;
  tool: TaskboardPreferencesToolName;
  outcome: "success" | "error";
  durationMs: number;
  refreshIntervalSeconds?: number;
  errorCode?: string;
}

export interface TaskboardPreferencesOperationLogger {
  completed(event: TaskboardPreferencesOperationEvent): void;
}

export class JsonStderrTaskboardPreferencesOperationLogger
implements TaskboardPreferencesOperationLogger {
  completed(event: TaskboardPreferencesOperationEvent): void {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  }
}
