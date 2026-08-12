import { randomUUID } from "node:crypto";

type Stage = "checking" | "downloading" | "verifying" | "staging" | "activating" | "rollback";
type Outcome = "success" | "error" | "skipped";

export class JsonUpdateLogger {
  constructor(private readonly write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)) {}

  started(stage: Stage, metadata: { platform?: string; currentVersion?: string; targetVersion?: string } = {}): string {
    const requestId = randomUUID();
    this.write(JSON.stringify({ timestamp: new Date().toISOString(), requestId, stage, outcome: "started", ...metadata }));
    return requestId;
  }

  completed(requestId: string, stage: Stage, metadata: {
    outcome: Outcome;
    errorCode?: string;
    durationMs?: number;
    currentVersion?: string;
    targetVersion?: string;
    platform?: string;
  }): void {
    const { outcome, errorCode, durationMs, currentVersion, targetVersion, platform } = metadata;
    this.write(JSON.stringify({
      timestamp: new Date().toISOString(), requestId, stage, outcome,
      ...(errorCode ? { errorCode } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(currentVersion ? { currentVersion } : {}),
      ...(targetVersion ? { targetVersion } : {}),
      ...(platform ? { platform } : {}),
    }));
  }
}
