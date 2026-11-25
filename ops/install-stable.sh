#!/bin/bash
# Installs, checks or rolls back the stable BillieWeather app on the daily-use Mac (the MacBook).
# Uses only what macOS ships with: no Homebrew, Ruby, Node or Rust needed.
#   install-stable.sh <release folder>        verify, back up, install
#   install-stable.sh --check <release folder> verify only (checksums, compatibility); changes nothing
#   install-stable.sh --status                installed version, database schema and backups
#   install-stable.sh --rollback [backup]     restore the app and data from a backup (default: newest)
# The release folder is what ops/release-build.sh produced (DMG, manifest.json, compat.json, SHA256SUMS).
set -euo pipefail
APP_ID=com.billieweather.client
# Overrides exist only for rehearsing in a scratch folder; normal use sets none of them.
APP="${BILLIE_INSTALL_APP:-/Applications/BillieWeather.app}"
DATA="${BILLIE_INSTALL_DATA:-$HOME/Library/Application Support/$APP_ID}"
BACKUPS="${BILLIE_INSTALL_BACKUPS:-$HOME/BillieWeather-Backups}"
die() { printf '\n  stopped: %s\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }
json() { plutil -extract "$2" raw -o - "$1"; }
running() { pgrep -xq billieweather && osascript -e "application id \"$APP_ID\" is running" 2>/dev/null | grep -q true; }
schema_of() { [[ -f "$1" ]] && /usr/bin/sqlite3 "file:$1?mode=ro" "select coalesce(max(version),0) from _sqlx_migrations" 2>/dev/null || echo 0; }
installed_version() { [[ -d "$APP" ]] && /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" || echo none; }

verify_release() {
  local dir="$1"
  [[ -f "$dir/SHA256SUMS" && -f "$dir/compat.json" ]] || die "$dir is not a release folder"
  (cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null) || die "checksums do not match: the files changed after the build"
  say "checksums ok"
  VERSION="$(json "$dir/compat.json" version)"; NEW_SCHEMA="$(json "$dir/compat.json" databaseSchema)"
  MIN_SCHEMA="$(json "$dir/compat.json" upgradesFromSchemaAtLeast)"; EXE_SHA="$(json "$dir/compat.json" executableSha256)"
  CUR_SCHEMA="$(schema_of "$DATA/billieweather.db")"
  say "release $VERSION (database schema $NEW_SCHEMA); installed $(installed_version) (schema $CUR_SCHEMA)"
  (( CUR_SCHEMA <= NEW_SCHEMA )) || die "your database (schema $CUR_SCHEMA) is newer than this release understands ($NEW_SCHEMA). Not installing a downgrade; use --rollback instead."
  (( CUR_SCHEMA == 0 || CUR_SCHEMA >= MIN_SCHEMA )) || die "schema $CUR_SCHEMA is too old for a direct upgrade (needs $MIN_SCHEMA+)"
  if [[ -f "$DATA/billieweather.db" ]]; then
    [[ "$(/usr/bin/sqlite3 "file:$DATA/billieweather.db?mode=ro" 'pragma integrity_check')" == ok ]] || die "the current database fails its integrity check — keep it as it is and ask for help"
    say "current database integrity ok"
  fi
  (( CUR_SCHEMA < NEW_SCHEMA && CUR_SCHEMA > 0 )) && say "note: after the upgrade, older versions cannot open the database; rollback restores the backup copy."
  return 0
}

backup_now() {  # app bundle + entire data folder, taken while the app is closed
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)-$(installed_version)${1:+-$1}"; local b="$BACKUPS/$stamp"
  mkdir -p "$b"; chmod 700 "$BACKUPS"
  [[ -d "$APP" ]] && ditto "$APP" "$b/BillieWeather.app"
  [[ -d "$DATA" ]] && ditto "$DATA" "$b/data"
  printf '{"takenAt":"%s","appVersion":"%s","schema":%s}\n' "$(date -u +%FT%TZ)" "$(installed_version)" "$(schema_of "$DATA/billieweather.db")" > "$b/backup.json"
  if [[ -f "$b/data/billieweather.db" ]]; then
    [[ "$(/usr/bin/sqlite3 "file:$b/data/billieweather.db?mode=ro" 'pragma integrity_check')" == ok ]] || die "backup copy failed its integrity check"
  fi
  echo "$b"
}

case "${1:-}" in
  --status)
    say "app:      $(installed_version)  ($APP)"
    say "database: schema $(schema_of "$DATA/billieweather.db")  ($DATA)"
    say "backups:"; ls -1t "$BACKUPS" 2>/dev/null | head -10 | sed 's/^/            /' || true ;;
  --check)
    verify_release "${2:?release folder}"; say "ready to install (nothing was changed)" ;;
  --rollback)
    b="${2:-$BACKUPS/$(ls -1t "$BACKUPS" 2>/dev/null | grep -v -- '-replaced-by-rollback$' | head -1)}"
    [[ -d "$b/BillieWeather.app" ]] || die "no app in backup $b"
    running && die "quit BillieWeather first (Cmd+Q), then run this again"
    say "restoring $(basename "$b")"
    aside="$(backup_now replaced-by-rollback)"; say "current state kept in $aside"
    rm -rf "$APP"; ditto "$b/BillieWeather.app" "$APP"
    if [[ -d "$b/data" ]]; then rm -rf "$DATA"; ditto "$b/data" "$DATA"; fi
    say "rolled back to $(installed_version), database schema $(schema_of "$DATA/billieweather.db")" ;;
  ""|-*) sed -n 2,9p "$0"; exit 2 ;;
  *)
    REL="$(cd "$1" && pwd)"; echo "== Verify"; verify_release "$REL"
    running && die "quit BillieWeather first (Cmd+Q), then run this again"
    echo "== Back up"; B="$(backup_now)"; say "saved to $B"
    echo "== Install"
    MNT="$(mktemp -d /tmp/billie-dmg.XXXXXX)"; trap 'hdiutil detach -quiet "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT
    hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MNT" "$REL/BillieWeather-$VERSION.dmg"
    SRC="$MNT/BillieWeather.app"; [[ -d "$SRC" ]] || die "no BillieWeather.app in the DMG"
    [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SRC/Contents/Info.plist")" == "$APP_ID" ]] || die "the DMG holds a different app identifier (QA builds are never installed here)"
    [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SRC/Contents/Info.plist")" == "$VERSION" ]] || die "version inside the DMG differs"
    [[ "$(shasum -a 256 "$SRC/Contents/MacOS/billieweather" | cut -d' ' -f1)" == "$EXE_SHA" ]] || die "the executable differs from the verified build"
    codesign --verify --deep --strict "$SRC" || die "signature check failed"
    ditto "$SRC" "$APP.new"; rm -rf "$APP"; mv "$APP.new" "$APP"
    say "installed $(installed_version). Your data folder was not modified; the app upgrades it on first launch"
    say "(and keeps its own pre-upgrade copy beside the database). Open BillieWeather and check your books."
    say "If anything is wrong: $0 --rollback \"$B\"" ;;
esac
