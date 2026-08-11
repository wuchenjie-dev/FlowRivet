import type { z } from "zod";

import {
  BoundedCommandRunner,
  CommandRunnerError,
  resolveExecutable,
  type CommandRunInput,
  type CommandRunResult,
} from "./command-runner.js";
import {
  meegleAuthStatusSchema,
  meegleDeviceInitSchema,
  meegleDevicePollSchema,
  meegleMyWorkPageSchema,
  meegleUserSchema,
  type MeegleAuthStatus,
  type MeegleMyWorkPage,
  type MeegleUser,
} from "./meegle-cli-contracts.js";

export type MeegleCliErrorCode =
  | "provider_cli_missing"
  | "provider_cli_unsupported"
  | "provider_unauthorized"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_cancelled"
  | "provider_output_limit"
  | "provider_invalid_response";

export class MeegleCliError extends Error {
  constructor(readonly code: MeegleCliErrorCode) {
    super(code);
    this.name = "MeegleCliError";
  }
}

export interface MeegleCommandRunner {
  run(input: CommandRunInput): Promise<CommandRunResult>;
}

export type MeegleMyWorkAction = "this_week" | "overdue" | "done";

export interface MeegleDeviceAttempt {
  profileName: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  clientId: string;
  deviceCode: string;
  expiresInSeconds: number;
  intervalMs: number;
  expiresAt: string;
}

export type MeegleDevicePollResult =
  | { state: "pending" }
  | { state: "authorized" }
  | { state: "expired" };

export class MeegleCliClient {
  private readonly runner: MeegleCommandRunner;
  private readonly explicitExecutablePath?: string;
  private readonly executableResolver: () => Promise<string>;
  private readonly clock: () => Date;

  constructor(options: {
    runner?: MeegleCommandRunner;
    executablePath?: string;
    executableResolver?: () => Promise<string>;
    clock?: () => Date;
  } = {}) {
    this.runner = options.runner ?? new BoundedCommandRunner();
    this.explicitExecutablePath = options.executablePath;
    this.executableResolver = options.executableResolver
      ?? (() => resolveExecutable({
        command: "meegle",
        ...(this.explicitExecutablePath
          ? { explicitPath: this.explicitExecutablePath }
          : {}),
      }));
    this.clock = options.clock ?? (() => new Date());
  }

  async getVersion(): Promise<string> {
    const result = await this.run(["--version"], { timeoutMs: 15_000 });
    const match = result.stdout.match(/(?:meegle\s+version\s+)?(\d+\.\d+\.\d+)/iu);
    if (!match?.[1]) throw new MeegleCliError("provider_invalid_response");
    if (compareVersions(match[1], "1.0.19") < 0) {
      throw new MeegleCliError("provider_cli_unsupported");
    }
    return match[1];
  }

  async getCurrentProfile(): Promise<string> {
    const result = await this.run(
      ["config", "profile", "current", "--format", "json"],
      { timeoutMs: 15_000 },
    );
    const profile = result.stdout.trim();
    if (!isSafeProfile(profile)) throw new MeegleCliError("provider_invalid_response");
    return profile;
  }

  async getAuthStatus(profile?: string): Promise<MeegleAuthStatus> {
    const args = ["auth", "status"];
    if (profile) args.push("--profile", validateProfile(profile));
    args.push("--format", "json");
    return this.runJson(args, meegleAuthStatusSchema, {
      timeoutMs: 15_000,
      allowExitCodes: [0, 1],
    });
  }

  async getCurrentUser(profile: string): Promise<MeegleUser> {
    return this.runJson([
      "user", "me",
      "--profile", validateProfile(profile),
      "--format", "json",
    ], meegleUserSchema, { timeoutMs: 15_000 });
  }

  async logout(profile: string): Promise<void> {
    await this.run([
      "auth", "logout",
      "--profile", validateProfile(profile),
      "--format", "json",
    ], { timeoutMs: 15_000 });
  }

  async getMyWorkPage(
    profile: string,
    action: MeegleMyWorkAction,
    pageNum: number,
  ): Promise<MeegleMyWorkPage> {
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > 1_000) {
      throw new MeegleCliError("provider_invalid_response");
    }
    return this.runJson([
      "mywork", "todo",
      "--action", action,
      "--page-num", String(pageNum),
      "--profile", validateProfile(profile),
      "--format", "json",
    ], meegleMyWorkPageSchema, { timeoutMs: 30_000 });
  }

  async initializeDeviceLogin(
    profileName: string,
    host: string,
    signal: AbortSignal,
  ): Promise<MeegleDeviceAttempt> {
    const profile = validateProfile(profileName);
    if (host !== "project.feishu.cn") throw new MeegleCliError("provider_invalid_response");
    const init = await this.runJson([
      "auth", "login", "--device-code",
      "--host", host,
      "--phase", "init",
      "--profile", profile,
      "--format", "json",
    ], meegleDeviceInitSchema, { timeoutMs: 15_000, signal });
    return {
      profileName: profile,
      verificationUri: init.verification_uri,
      verificationUriComplete: init.verification_uri_complete,
      userCode: init.user_code,
      clientId: init.client_id,
      deviceCode: init.device_code,
      expiresInSeconds: init.expires_in,
      intervalMs: init.interval * 1_000,
      expiresAt: new Date(
        this.clock().getTime() + init.expires_in * 1_000,
      ).toISOString(),
    };
  }

  async pollDeviceLogin(
    profileName: string,
    attempt: MeegleDeviceAttempt,
    signal: AbortSignal,
  ): Promise<MeegleDevicePollResult> {
    const profile = validateProfile(profileName);
    if (attempt.profileName !== profile) {
      throw new MeegleCliError("provider_invalid_response");
    }
    const poll = await this.runJson([
      "auth", "login", "--device-code",
      "--host", "project.feishu.cn",
      "--phase", "poll", "--once",
      "--profile", profile,
      "--client-id", attempt.clientId,
      "--device-code-value", attempt.deviceCode,
      "--expires-in", String(attempt.expiresInSeconds),
      "--interval", String(attempt.intervalMs / 1_000),
      "--format", "json",
    ], meegleDevicePollSchema, {
      timeoutMs: 15_000,
      signal,
      allowExitCodes: [0, 1],
    });
    if ("status" in poll) return poll.status === "ok"
      ? { state: "authorized" }
      : { state: "pending" };
    return poll.error === "expired_token"
      ? { state: "expired" }
      : { state: "pending" };
  }

  private async runJson<T extends z.ZodType>(
    args: string[],
    schema: T,
    options: Omit<CommandRunInput, "args" | "executablePath">,
  ): Promise<z.infer<T>> {
    const result = await this.run(args, options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new MeegleCliError("provider_invalid_response");
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) throw new MeegleCliError("provider_invalid_response");
    return validated.data;
  }

  private async run(
    args: string[],
    options: Omit<CommandRunInput, "args" | "executablePath">,
  ): Promise<CommandRunResult> {
    try {
      const executablePath = await this.executableResolver();
      return await this.runner.run({ executablePath, args, ...options });
    } catch (error) {
      if (error instanceof MeegleCliError) throw error;
      throw mapRunnerError(error);
    }
  }
}

function mapRunnerError(error: unknown) {
  if (!(error instanceof CommandRunnerError)) {
    return new MeegleCliError("provider_unavailable");
  }
  switch (error.code) {
    case "provider_cli_missing":
    case "provider_timeout":
    case "provider_cancelled":
    case "provider_output_limit":
      return new MeegleCliError(error.code);
    case "provider_command_failed":
      return new MeegleCliError(error.exitCode === 1
        ? "provider_unauthorized"
        : "provider_unavailable");
    default:
      return new MeegleCliError("provider_unavailable");
  }
}

function validateProfile(profile: string) {
  if (!isSafeProfile(profile)) throw new MeegleCliError("provider_invalid_response");
  return profile;
}

function isSafeProfile(profile: string) {
  return /^[\p{L}\p{N}._ -]{1,128}$/u.test(profile);
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
