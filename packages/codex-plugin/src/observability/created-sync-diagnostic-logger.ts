import { createHash } from "node:crypto";

export interface CreatedSyncDiagnosticEvent {
  mode: "manual" | "automatic";
  catalog: "available" | "partial" | "unavailable";
  totalTypeCount: number;
  scannedTypeCount: number;
  batchCompleted: boolean;
  attemptedIdentityHashes: string[];
}

export interface CreatedSyncDiagnosticLogger {
  completed(event: CreatedSyncDiagnosticEvent): void;
}

export function createdSyncIdentityHash(projectKey: string, typeKey: string): string {
  return createHash("sha256")
    .update(JSON.stringify([projectKey, typeKey]))
    .digest("hex")
    .slice(0, 16);
}

export class JsonStderrCreatedSyncDiagnosticLogger implements CreatedSyncDiagnosticLogger {
  completed(event: CreatedSyncDiagnosticEvent): void {
    process.stderr.write(`${JSON.stringify({ event: "created_sync.completed", ...event })}\n`);
  }
}

export class NoopCreatedSyncDiagnosticLogger implements CreatedSyncDiagnosticLogger {
  completed(_event: CreatedSyncDiagnosticEvent): void {}
}
