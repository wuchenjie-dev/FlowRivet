export type ProjectToolName =
  | "discover_projects"
  | "save_project_selection"
  | "add_project";

export interface ProjectOperationEvent {
  requestId: string;
  tool: ProjectToolName;
  providerId: string;
  outcome: "success" | "error";
  durationMs: number;
  errorCode?: string;
}

export interface ProjectOperationLogger {
  completed(event: ProjectOperationEvent): void;
}

export class JsonStderrProjectOperationLogger implements ProjectOperationLogger {
  completed(event: ProjectOperationEvent): void {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  }
}
