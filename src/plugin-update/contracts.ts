export interface PluginUpdateOptions {
  pull: boolean;
  json: boolean;
  adoptLegacyCompanion: boolean;
}

export interface PluginUpdateResult {
  ok: true;
  plugin: string;
  marketplace: string;
  version: string;
  companion: {
    pid: number;
    instanceId: string;
    healthUrl: string;
  };
  codexRestartRequired: true;
}

export type PluginUpdateErrorCode =
  | "plugin_source_not_found"
  | "codex_cli_not_found"
  | "plugin_marketplace_mismatch"
  | "plugin_marketplace_ambiguous"
  | "git_worktree_dirty"
  | "git_upstream_missing"
  | "git_pull_failed"
  | "build_failed"
  | "plugin_cachebuster_failed"
  | "plugin_install_failed"
  | "plugin_manifest_restore_failed"
  | "plugin_manifest_recovery_conflict"
  | "plugin_update_in_progress"
  | "companion_ownership_unverified"
  | "companion_legacy_confirmation_required"
  | "companion_start_failed"
  | "companion_health_timeout"
  | "plugin_updater_unavailable";

export class PluginUpdateError extends Error {
  readonly code: PluginUpdateErrorCode;

  constructor(code: PluginUpdateErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginUpdateError";
    this.code = code;
  }
}

export type PluginUpdateService = (
  options: PluginUpdateOptions,
  environment: Record<string, string | undefined>,
) => Promise<PluginUpdateResult>;
