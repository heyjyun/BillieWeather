#!/usr/bin/env bash
# Installs (or with --remove, removes) the per-user LaunchAgent that resumes interrupted agent tasks
# every 30 minutes. Mac mini only. Nothing runs unless ops/agent-run.sh has a task marked interrupted.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(cat "$HOME/.billieweather-dev/role" 2>/dev/null)" == devbox ]] || { echo "not the development Mac" >&2; exit 1; }
P="$HOME/Library/LaunchAgents/com.billieweather.agent-recover.plist"
launchctl bootout "gui/$(id -u)" "$P" 2>/dev/null || true
if [[ "${1:-}" == --remove ]]; then rm -f "$P"; echo "removed"; exit 0; fi
mkdir -p "$HOME/.billieweather-dev/logs" "$(dirname "$P")"
sed -e "s#__REPO__#$PWD#g" -e "s#__HOME__#$HOME#g" ops/launchd/com.billieweather.agent-recover.plist.template >"$P"
plutil -lint "$P" >/dev/null && launchctl bootstrap "gui/$(id -u)" "$P" && echo "installed: $P"
