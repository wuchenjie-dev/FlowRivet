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
FLOWRIVET_URL="$FLOWRIVET_GITLAB_BASE_URL/api/v4/projects/$FLOWRIVET_PROJECT_ID/packages/generic/flowrivet-runtime/$FLOWRIVET_VERSION/flowrivet-runtime-$FLOWRIVET_PLATFORM-v$FLOWRIVET_VERSION.tar.gz"
printf 'header = "DEPLOY-TOKEN: %s"\nurl = "%s"\noutput = "%s"\n' "$FLOWRIVET_TOKEN" "$FLOWRIVET_URL" "$FLOWRIVET_ARCHIVE" \
  | curl --fail --silent --show-error --config -
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
