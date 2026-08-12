#!/bin/sh
set -eu

: "${FLOWRIVET_GITLAB_BASE_URL:?FLOWRIVET_GITLAB_BASE_URL is required}"
: "${FLOWRIVET_PROJECT_ID:?FLOWRIVET_PROJECT_ID is required}"
: "${FLOWRIVET_VERSION:?FLOWRIVET_VERSION is required}"
case "$FLOWRIVET_GITLAB_BASE_URL" in https://*) ;; *) echo registry_url_insecure >&2; exit 2 ;; esac

if [ "$(uname -s)" = "Darwin" ]; then
  FLOWRIVET_ROOT="$HOME/Library/Application Support/FlowRivet"
  FLOWRIVET_PLATFORM="darwin-$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/')"
else
  FLOWRIVET_ROOT="$HOME/.local/share/flowrivet"
  command -v secret-tool >/dev/null 2>&1 || { echo credential_store_unavailable >&2; exit 3; }
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 || { echo user_systemd_unavailable >&2; exit 4; }
  FLOWRIVET_PLATFORM="linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
fi
read -r -s -p "GitLab Deploy Token: " FLOWRIVET_TOKEN
printf '\n'
FLOWRIVET_TEMP="$(mktemp -d)"
trap 'unset FLOWRIVET_TOKEN; rm -rf "$FLOWRIVET_TEMP"' EXIT HUP INT TERM
FLOWRIVET_ARCHIVE="$FLOWRIVET_TEMP/runtime.tar.gz"
FLOWRIVET_MANIFEST="$FLOWRIVET_TEMP/release-manifest.json"
FLOWRIVET_PACKAGE_BASE="$FLOWRIVET_GITLAB_BASE_URL/api/v4/projects/$FLOWRIVET_PROJECT_ID/packages/generic/flowrivet-runtime/$FLOWRIVET_VERSION"
printf 'header = "DEPLOY-TOKEN: %s"\nurl = "%s/release-manifest.json"\noutput = "%s"\n' "$FLOWRIVET_TOKEN" "$FLOWRIVET_PACKAGE_BASE" "$FLOWRIVET_MANIFEST" \
  | curl --fail --silent --show-error --config -
if [ "$(uname -s)" = "Darwin" ]; then
  manifest_value() { /usr/bin/plutil -extract "$1" raw -o - "$FLOWRIVET_MANIFEST"; }
else
  command -v python3 >/dev/null 2>&1 || { echo json_parser_unavailable >&2; exit 5; }
  manifest_value() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); print(__import__("functools").reduce(lambda v,k:v[k], sys.argv[2].split("."), d))' "$FLOWRIVET_MANIFEST" "$1"; }
fi
FLOWRIVET_EXPECTED_FILE="flowrivet-runtime-$FLOWRIVET_PLATFORM-v$FLOWRIVET_VERSION.tar.gz"
[ "$(manifest_value schemaVersion)" = "1" ] || { echo manifest_schema_invalid >&2; exit 6; }
[ "$(manifest_value version)" = "$FLOWRIVET_VERSION" ] || { echo manifest_version_mismatch >&2; exit 6; }
FLOWRIVET_FILE="$(manifest_value "packages.$FLOWRIVET_PLATFORM.file")"
FLOWRIVET_SIZE="$(manifest_value "packages.$FLOWRIVET_PLATFORM.size")"
FLOWRIVET_SHA256="$(manifest_value "packages.$FLOWRIVET_PLATFORM.sha256")"
[ "$FLOWRIVET_FILE" = "$FLOWRIVET_EXPECTED_FILE" ] || { echo manifest_file_invalid >&2; exit 6; }
printf 'header = "DEPLOY-TOKEN: %s"\nurl = "%s/%s"\noutput = "%s"\n' "$FLOWRIVET_TOKEN" "$FLOWRIVET_PACKAGE_BASE" "$FLOWRIVET_FILE" "$FLOWRIVET_ARCHIVE" \
  | curl --fail --silent --show-error --config -
FLOWRIVET_ACTUAL_SIZE="$(wc -c < "$FLOWRIVET_ARCHIVE" | tr -d ' ')"
[ "$FLOWRIVET_ACTUAL_SIZE" = "$FLOWRIVET_SIZE" ] || { echo package_size_mismatch >&2; exit 7; }
if command -v sha256sum >/dev/null 2>&1; then
  FLOWRIVET_ACTUAL_SHA256="$(sha256sum "$FLOWRIVET_ARCHIVE" | awk '{print $1}')"
else
  FLOWRIVET_ACTUAL_SHA256="$(shasum -a 256 "$FLOWRIVET_ARCHIVE" | awk '{print $1}')"
fi
[ "$FLOWRIVET_ACTUAL_SHA256" = "$FLOWRIVET_SHA256" ] || { echo package_hash_mismatch >&2; exit 7; }
FLOWRIVET_VERSION_ROOT="$FLOWRIVET_ROOT/versions/$FLOWRIVET_VERSION"
mkdir -p "$FLOWRIVET_VERSION_ROOT"
tar -xzf "$FLOWRIVET_ARCHIVE" -C "$FLOWRIVET_VERSION_ROOT"
printf '{"schemaVersion":1,"activeVersion":"%s","activatedAt":"%s"}\n' "$FLOWRIVET_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$FLOWRIVET_ROOT/current.json"
FLOWRIVET_NODE="$FLOWRIVET_VERSION_ROOT/runtime/node"
FLOWRIVET_UPDATER="$FLOWRIVET_VERSION_ROOT/app/packages/updater/dist/main.js"
printf '%s\n' "$FLOWRIVET_TOKEN" | "$FLOWRIVET_NODE" "$FLOWRIVET_UPDATER" configure --token-stdin --gitlab-base-url "$FLOWRIVET_GITLAB_BASE_URL" --project-id "$FLOWRIVET_PROJECT_ID"
if [ "$(uname -s)" = "Darwin" ]; then
  FLOWRIVET_AGENT="$HOME/Library/LaunchAgents/cn.flowrivet.updater.plist"
  mkdir -p "$(dirname "$FLOWRIVET_AGENT")"
  cat > "$FLOWRIVET_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>cn.flowrivet.updater</string><key>ProgramArguments</key><array><string>$FLOWRIVET_NODE</string><string>$FLOWRIVET_UPDATER</string><string>run</string></array><key>RunAtLoad</key><true/></dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/cn.flowrivet.updater" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$FLOWRIVET_AGENT"
else
  FLOWRIVET_UNIT="$HOME/.config/systemd/user/flowrivet-updater.service"
  mkdir -p "$(dirname "$FLOWRIVET_UNIT")"
  cat > "$FLOWRIVET_UNIT" <<EOF
[Unit]
Description=FlowRivet updater
[Service]
ExecStart=$FLOWRIVET_NODE $FLOWRIVET_UPDATER run
Restart=on-failure
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now flowrivet-updater.service
fi
