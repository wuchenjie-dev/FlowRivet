export type UpdateResult =
  | { outcome: "current" | "cooldown"; version: string }
  | { outcome: "updated"; version: string; previousVersion: string };

export interface UpdateServiceDependencies {
  currentVersion(): Promise<string>;
  acquireLock(): Promise<() => Promise<void>>;
  resolveRelease(currentVersion: string): Promise<{ version: string }>;
  isCoolingDown(version: string): Promise<boolean>;
  stage(version: string): Promise<void>;
  stopCurrent(): Promise<void>;
  startVersion(version: string): Promise<unknown>;
  activate(version: string, previousVersion: string): Promise<void>;
  recordSuccess(version: string): Promise<void>;
  recordFailure(version: string, errorCode: string): Promise<void>;
}

export class UpdateService {
  constructor(private readonly dependencies: UpdateServiceDependencies) {}

  async checkAndInstall(): Promise<UpdateResult> {
    const release = await this.dependencies.acquireLock();
    try {
      const currentVersion = await this.dependencies.currentVersion();
      const candidate = await this.dependencies.resolveRelease(currentVersion);
      if (candidate.version === currentVersion) return { outcome: "current", version: currentVersion };
      if (await this.dependencies.isCoolingDown(candidate.version)) {
        return { outcome: "cooldown", version: candidate.version };
      }
      await this.dependencies.stage(candidate.version);
      await this.dependencies.stopCurrent();
      try {
        await this.dependencies.startVersion(candidate.version);
        await this.dependencies.activate(candidate.version, currentVersion);
      } catch (error) {
        const errorCode = "candidate_activation_failed";
        try {
          await this.dependencies.stopCurrent();
        } catch {
          // A candidate that already exited has nothing left to stop.
        }
        try {
          await this.dependencies.startVersion(currentVersion);
        } catch (rollbackError) {
          await this.dependencies.recordFailure(candidate.version, "rollback_failed");
          throw new Error("rollback_failed", { cause: rollbackError });
        }
        await this.dependencies.recordFailure(candidate.version, errorCode);
        throw new Error(errorCode, { cause: error });
      }
      await this.dependencies.recordSuccess(candidate.version);
      return { outcome: "updated", version: candidate.version, previousVersion: currentVersion };
    } finally {
      await release();
    }
  }
}
