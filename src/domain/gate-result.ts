export type FindingSeverity = "blocking" | "important" | "suggestion";

export interface GateFinding {
  code: string;
  severity: FindingSeverity;
  field: string;
  message: string;
}

export interface GateResult {
  passed: boolean;
  findings: GateFinding[];
}
