#!/usr/bin/env bash
# Builds and installs "BillieWeather Dev.app" next to the Stable app, on either Mac.
#   ops/install-dev.sh            build (release mode) and install /Applications/BillieWeather Dev.app
#   ops/install-dev.sh --status   what is installed, and where each app keeps its data
#
# The Dev app is com.billieweather.client.dev: its own SQLite folder, keychain entry, WebView storage,
# caches and billieweather-dev:// link scheme. It talks only to the development servers on this
# computer (localhost:3000 / localhost:8100), which use the independent Neon Development project. It never touches /Applications/BillieWeather.app (Stable) or its data.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DEV_ID=com.billieweather.client.dev
STABLE_ID=com.billieweather.client
DEST="${BILLIE_DEV_APP:-/Applications/BillieWeather Dev.app}"
die() { printf '\n  install-dev: %s\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || echo "-"; }

case "$(basename "$DEST")" in "BillieWeather Dev.app") ;; *) die "refusing to install anywhere but a 'BillieWeather Dev.app' path ($DEST)" ;; esac

status() {
  for app in "/Applications/BillieWeather.app" "$DEST"; do
    if [[ -d "$app" ]]; then say "$(basename "$app"): $(plist "$app" CFBundleIdentifier) $(plist "$app" CFBundleShortVersionString) (build $(plist "$app" CFBundleVersion))"
    else say "$(basename "$app"): not installed"; fi
  done
  for id in "$STABLE_ID" "$DEV_ID"; do
    say "$id data:     ~/Library/Application Support/$id $( [[ -d "$HOME/Library/Application Support/$id" ]] && echo '(exists)' || echo '(none yet)')"
    say "$id WebView:  ~/Library/WebKit/$id $( [[ -d "$HOME/Library/WebKit/$id" ]] && echo '(exists)' || echo '(none yet)')"
    say "$id keychain: service \"$id\" $(security find-generic-password -s "$id" -a session >/dev/null 2>&1 && echo '(signed in)' || echo '(no token)')"
  done
}
[[ "${1:-}" == --status ]] && { status; exit 0; }

eval "$(mise activate bash 2>/dev/null)" || true
if osascript -e "application id \"$DEV_ID\" is running" 2>/dev/null | grep -q true; then
  die "BillieWeather Dev is running; quit it first (Stable may stay open)"
fi

say "building BillieWeather Dev (release mode, local servers, $DEV_ID)…"
export CARGO_TARGET_DIR="${BILLIE_DEV_TARGET_DIR:-$ROOT/clients/universal/src-tauri/target-dev}"
LOG="$(mktemp -t billie-dev-build)"
(cd clients/universal && BILLIE_VARIANT=dev BILLIE_API_URL=http://localhost:3000 BILLIE_IDENTITY_URL=http://localhost:8100 \
  node scripts/tauri.mjs build --bundles app) >"$LOG" 2>&1 || { tail -40 "$LOG"; die "build failed (log: $LOG)"; }
BUILT="$CARGO_TARGET_DIR/release/bundle/macos/BillieWeather Dev.app"
[[ -d "$BUILT" ]] || die "no bundle at $BUILT (log: $LOG)"

ID="$(plist "$BUILT" CFBundleIdentifier)"
[[ "$ID" == "$DEV_ID" ]] || die "built $ID, expected $DEV_ID; not installing"
grep -aq "localhost:3000" "$BUILT/Contents/MacOS/billieweather" || die "the build does not point at the local development API"
if grep -aq "onrender.com" "$BUILT/Contents/MacOS/billieweather"; then die "the Dev build mentions a hosted server; not installing"; fi

if ! codesign --verify --deep --strict "$BUILT" 2>/dev/null; then
  codesign --force --sign - --timestamp=none "$BUILT"
fi
codesign --verify --deep --strict "$BUILT" || die "Dev bundle failed signature verification"

if [[ -d "$DEST" ]]; then
  OLD="$HOME/BillieWeather-Backups/dev-app-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$OLD" && mv "$DEST" "$OLD/" && say "previous Dev app moved to $OLD"
fi
ditto "$BUILT" "$DEST"
say "installed $DEST ($(plist "$DEST" CFBundleShortVersionString), build $(plist "$DEST" CFBundleVersion))"
echo; status
echo; say "Start Rails on :3000 and identity on :8100 using the Development project, then open BillieWeather Dev."
