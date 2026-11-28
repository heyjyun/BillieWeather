#!/usr/bin/env bash
# Automatic Development updates: committed `main` → Development Web (:3000/:8100) + BillieWeather Dev.app.
#
#   ops/dev-update.sh run [--force]    update to the current committed main (no-op when already there)
#   ops/dev-update.sh status           deployed commit, installed Dev.app build/commit, services, last failure
#   ops/dev-update.sh install-agent    install/refresh the launchd job that runs `run` automatically
#   ops/dev-update.sh remove-agent     unload and delete that job
#
# Every run builds from a `git archive` snapshot of refs/heads/main — never the working tree — so
# uncommitted work from concurrent sessions is never built, served or installed. No branch, worktree or
# checkout is created. Stages, each of which stops the run and keeps the last working build on failure:
#   1. snapshot   git archive <sha> into ~/.billieweather-dev/dev-update/runtime/<sha>; cached dependencies
#   2. validate   Rails eager-load check; Universal typecheck + production bundle (part of the Tauri build)
#   3. migrate    Neon `development` only (identity verified); pending migrations must be additive
#   4. build      Dev.app with the commit's build number and embedded commit; bundle checks as install-dev.sh
#   5. services   restart Rails/identity from the snapshot in tmux (billie-rails, billie-id); health checks;
#                 on failure the previous snapshot is restarted
#   6. install    swap /Applications/BillieWeather Dev.app (previous copies kept); deferred while Dev is open
# Stable (/Applications/BillieWeather.app), its data, Production and the Neon production branch are never
# touched. Runs are serialized by a lock; the job runs at background priority.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${BILLIE_DEV_UPDATE_HOME:-$HOME/.billieweather-dev/dev-update}"
RUNTIMES="$BASE/runtime"; CACHE="$BASE/cache"; LOGS="$BASE/logs"; APPS="$BASE/previous-apps"; STAGED="$BASE/staged"
DEST="/Applications/BillieWeather Dev.app"; DEV_ID=com.billieweather.client.dev
STABLE_APP="/Applications/BillieWeather.app"
PROD_ENDPOINTS="${BILLIE_PROD_ENDPOINTS:-ep-raspy-sound}"   # Neon production endpoint ids: never migrate these
LABEL=com.billieweather.dev-update
KEEP_APPS=3; KEEP_RUNTIMES=2
mkdir -p "$RUNTIMES" "$CACHE" "$LOGS" "$APPS" "$STAGED"; chmod 700 "$BASE"
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
eval "$(mise activate bash 2>/dev/null)" 2>/dev/null || true
export PATH="$HOME/.local/share/mise/installs/ruby/4.0.3/bin:$PATH"   # Gemfile pins 4.0.3

say() { printf '%s dev-update: %s\n' "$(date '+%F %T')" "$*"; }
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || echo "-"; }
state() { cat "$BASE/$1" 2>/dev/null || true; }
setstate() { printf '%s\n' "$2" >"$BASE/$1"; }
notify() { osascript -e "display notification \"$2\" with title \"BillieWeather Dev\" subtitle \"$1\"" >/dev/null 2>&1 || true; }
pid_on() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
dev_running() { pgrep -f "BillieWeather Dev.app/Contents/MacOS/" >/dev/null 2>&1; }
embeds() { [[ -n "$2" ]] && grep -aqF "$2" "$1/Contents/MacOS/billieweather" 2>/dev/null; }   # Rust packs literals: search bytes
all_but_newest() { sort | awk -v k="$1" '{a[NR]=$0} END {for (i = 1; i <= NR - k; i++) print a[i]}'; }

FAIL_STAGE=""
fail() {  # $1 stage, $2 reason — keeps the last working build and services
  setstate failed-sha "${SHA:-?}"; setstate failed-reason "$1: $2 ($(date '+%F %T'), log ${LOG:-?})"
  say "FAILED at $1: $2"; notify "Update to ${SHA:0:8} failed" "$1: $2. The previous Dev build stays installed."
  exit 1
}

acquire() {
  local lock="$BASE/lock.d" pid waited=0
  while ! mkdir "$lock" 2>/dev/null; do
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
    [[ "${1:-}" == wait ]] || { say "another update is running (pid $pid); skipping"; exit 0; }
    (( waited++ > 3600 )) && { say "lock wait timed out"; exit 1; }; sleep 1
  done
  echo $$ >"$lock/pid"; trap 'rm -rf "$BASE/lock.d"' EXIT
}

# --- 6. install (also used to finish a deferred install) ----------------------------------------------
install_app() {  # $1 built bundle, $2 sha, $3 build number
  local built="$1" new="/Applications/.BillieWeather Dev.app.installing"
  if dev_running; then
    if [[ "$built" != "$STAGED/"* ]]; then rm -rf "$STAGED/app"; mkdir -p "$STAGED/app"; ditto "$built" "$STAGED/app/BillieWeather Dev.app"; fi
    setstate staged-build "$2 $3"; say "BillieWeather Dev is open: build $3 is staged and installs after you quit it"
    notify "Build $3 ready" "Quit BillieWeather Dev to finish the update (checked every few minutes)."
    return 0
  fi
  rm -rf "$new"; ditto "$built" "$new"
  codesign --verify --deep --strict "$new" || { rm -rf "$new"; fail install "copied bundle failed signature verification"; }
  [[ "$(plist "$new" CFBundleIdentifier)" == "$DEV_ID" && "$(plist "$new" CFBundleVersion)" == "$3" ]] || { rm -rf "$new"; fail install "copied bundle has the wrong identity or build"; }
  if [[ -d "$DEST" ]]; then
    local keep; keep="$APPS/$(date +%Y%m%d-%H%M%S)-build$(plist "$DEST" CFBundleVersion)"; mkdir -p "$keep"
    mv "$DEST" "$keep/"
  fi
  mv "$new" "$DEST"
  ls -1d "$APPS"/*/ 2>/dev/null | all_but_newest "$KEEP_APPS" | while read -r d; do rm -rf "$d"; done || true
  [[ "$(plist "$DEST" CFBundleVersion)" == "$3" ]] && embeds "$DEST" "$2" || fail install "installed app does not report build $3 / commit $2"
  rm -rf "$STAGED/app"; setstate staged-build ""
  setstate installed "$2 $3"; say "installed $DEST: build $3, commit $2"
}

finish_staged() {
  local s; s="$(state staged-build)"; [[ -n "$s" && -d "$STAGED/app/BillieWeather Dev.app" ]] || return 0
  dev_running && return 0
  SHA="${s%% *}"; install_app "$STAGED/app/BillieWeather Dev.app" "${s%% *}" "${s##* }"
  notify "Updated to build ${s##* }" "BillieWeather Dev now runs commit ${SHA:0:8}."
}

# --- dependencies: cached per lockfile, cloned (APFS copy-on-write) into each snapshot -----------------
deps() {  # $1 snapshot
  local rt="$1" h c
  h="$(shasum -a 256 "$rt/clients/universal/package-lock.json" | cut -c1-16)"; c="$CACHE/universal-node_modules-$h"
  if [[ ! -d "$c" ]]; then
    say "installing Universal Client dependencies (lockfile $h)"
    (cd "$rt/clients/universal" && npm ci --prefer-offline --no-audit --no-fund --loglevel=error) || fail snapshot "npm ci failed"
    mv "$rt/clients/universal/node_modules" "$c.tmp" && mv "$c.tmp" "$c"
  fi
  rm -rf "$rt/clients/universal/node_modules"; cp -cR "$c" "$rt/clients/universal/node_modules"
  h="$(shasum -a 256 "$rt/yarn.lock" | cut -c1-16)"; c="$CACHE/root-node_modules-$h"
  if [[ ! -d "$c" ]]; then
    say "installing web dependencies (yarn.lock $h)"
    (cd "$rt" && yarn install --immutable >/dev/null) || fail snapshot "yarn install failed"
    mv "$rt/node_modules" "$c.tmp" && mv "$c.tmp" "$c"
  fi
  rm -rf "$rt/node_modules"; cp -cR "$c" "$rt/node_modules"
  (cd "$rt" && bundle check >/dev/null 2>&1) || (cd "$rt" && bundle install --quiet) || fail snapshot "bundle install failed"
}

# --- database: Neon development only ------------------------------------------------------------------
verify_dev_db() {  # $1 snapshot; prints nothing, fails unless .env.local pins the development branch
  local env="$1/.env.local" url host pinned
  [[ -f "$env" ]] || fail migrate "no .env.local (run ops/neon-dev-env.sh)"
  grep -qx 'BILLIE_DB_ENV=development' "$env" || fail migrate ".env.local is not pinned to BILLIE_DB_ENV=development"
  url="$(sed -n 's/^DATABASE_URL_UNPOOLED=//p' "$env" | tr -d '"'"'")"; host="${url#*@}"; host="${host%%[/:?]*}"
  pinned="$(sed -n 's/^BILLIE_DB_HOST=//p' "$env" | tr -d '"'"'")"
  [[ -n "$host" ]] || fail migrate "no DATABASE_URL_UNPOOLED in .env.local"
  for p in $PROD_ENDPOINTS; do [[ "$host" != *"$p"* ]] || fail migrate "the database host is the production endpoint ($p); refusing"; done
  [[ -z "$pinned" || "${host%%.*}" == "${pinned%%.*}"* || "$pinned" == *"${host%%.*}"* ]] || fail migrate "database host $host does not match BILLIE_DB_HOST $pinned"
}

migrate() {  # $1 snapshot
  local rt="$1" pending f bad=""
  verify_dev_db "$rt"
  pending="$(cd "$rt" && bin/billie-dev-db db:migrate:status 2>&1)" || fail migrate "cannot read migration status: $(echo "$pending" | tail -2 | tr '\n' ' ')"
  pending="$(echo "$pending" | awk '$1=="down"{print $2}')"
  if [[ -z "$pending" ]]; then say "Development database is current"; return 0; fi
  for v in $pending; do
    f="$(ls "$rt"/db/migrate/"$v"_*.rb 2>/dev/null | head -1)"; [[ -n "$f" ]] || { bad="$bad $v(missing file)"; continue; }
    if grep -Eq '\b(drop_table|remove_column|remove_columns|rename_column|rename_table|remove_reference|remove_belongs_to|drop_join_table|change_table)\b|\bchange_column[[:space:](]|execute.*\b(DELETE|DROP|TRUNCATE|UPDATE|ALTER[[:space:]]+TABLE[^;]*DROP)\b' "$f"; then
      bad="$bad $(basename "$f")"
    fi
  done
  [[ -z "$bad" ]] || fail migrate "pending migrations are not purely additive and need review:$bad"
  say "applying $(echo "$pending" | wc -w | tr -d ' ') migration(s) to Neon development: $(echo $pending)"
  (cd "$rt" && bin/billie-dev-db db:migrate) || fail migrate "db:migrate failed"
  (cd "$rt" && bin/billie-dev-db db:abort_if_pending_migrations) || fail migrate "migrations still pending after db:migrate"
}

# --- 4. build -------------------------------------------------------------------------------------------
build_app() {  # $1 snapshot, $2 sha, $3 build number → prints bundle path
  local rt="$1" shim="$BASE/bin"
  mkdir -p "$shim"
  # tauri.mjs reads the build number and source revision from git; the snapshot has no .git.
  cat >"$shim/git" <<'SH'
#!/bin/sh
case "$*" in
  "rev-list --count HEAD") echo "$BILLIE_BUILD_NUMBER"; exit 0 ;;
  "rev-parse HEAD") echo "$BILLIE_SOURCE_REVISION"; exit 0 ;;
  "status --porcelain") exit 0 ;;
esac
exec /usr/bin/git "$@"
SH
  chmod +x "$shim/git"
  export CARGO_TARGET_DIR="$CACHE/cargo-target-dev"
  (cd "$rt/clients/universal" && PATH="$shim:$PATH" BILLIE_BUILD_NUMBER="$3" BILLIE_SOURCE_REVISION="$2" \
    BILLIE_VARIANT=dev BILLIE_API_URL=http://localhost:3000 BILLIE_IDENTITY_URL=http://localhost:8100 \
    node scripts/tauri.mjs build --bundles app) >&2 || fail build "tauri build failed (typecheck, bundle or Rust)"
  local b="$CARGO_TARGET_DIR/release/bundle/macos/BillieWeather Dev.app"
  [[ -d "$b" ]] || fail build "no bundle produced"
  [[ "$(plist "$b" CFBundleIdentifier)" == "$DEV_ID" ]] || fail build "built $(plist "$b" CFBundleIdentifier), expected $DEV_ID"
  [[ "$(plist "$b" CFBundleVersion)" == "$3" ]] || fail build "bundle build number $(plist "$b" CFBundleVersion) != $3"
  embeds "$b" "$2" || fail build "bundle does not embed commit $2"
  grep -aq "localhost:3000" "$b/Contents/MacOS/billieweather" || fail build "build does not point at the local development API"
  ! grep -aq "onrender.com" "$b/Contents/MacOS/billieweather" || fail build "Dev build mentions a hosted server"
  codesign --verify --deep --strict "$b" 2>/dev/null || codesign --force --sign - --timestamp=none "$b" >&2
  codesign --verify --deep --strict "$b" || fail build "bundle failed signature verification"
  echo "$b"
}

# --- 5. services ----------------------------------------------------------------------------------------
stop_port() {
  local pid; pid="$(pid_on "$1")"; [[ -n "$pid" ]] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  kill -KILL "$pid" 2>/dev/null || true
}
start_services() {  # $1 snapshot
  local rt="$1"
  tmux kill-session -t billie-rails 2>/dev/null || true; tmux kill-session -t billie-id 2>/dev/null || true
  tmux kill-session -t billie-identity 2>/dev/null || true
  stop_port 3000; stop_port 8100
  tmux new-session -d -s billie-id -c "$rt/services/identity-api" \
    "UV_PROJECT_ENVIRONMENT='$CACHE/identity-venv' uv run --frozen uvicorn identity_api.main:app --host 127.0.0.1 --port 8100 --no-access-log 2>&1 | tee -a '$LOGS/identity.log'"
  tmux new-session -d -s billie-rails -c "$rt" \
    "eval \"\$(mise activate bash 2>/dev/null)\"; export PATH=\"\$HOME/.local/share/mise/installs/ruby/4.0.3/bin:\$PATH\"; bin/rails server -b 127.0.0.1 -p 3000 2>&1 | tee -a '$LOGS/rails.log'"
}
healthy() {  # $1 snapshot
  local ok=""
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null http://127.0.0.1:3000/up && curl -fsS -o /dev/null http://127.0.0.1:8100/health; then ok=1; break; fi
    sleep 1
  done
  [[ -n "$ok" ]] || return 1
  [[ "$(cwd_of "$(pid_on 3000)")" == "$1" ]]
}

# --- run ------------------------------------------------------------------------------------------------
run() {
  local force="${1:-}"
  acquire
  finish_staged
  SHA="$(git -C "$REPO" rev-parse --verify refs/heads/main)"; BUILD="$(git -C "$REPO" rev-list --count "$SHA")"
  local short="${SHA:0:12}" rt="$RUNTIMES/${SHA:0:12}"
  if [[ "$force" != --force ]]; then
    if [[ "$(state deployed)" == "$SHA" && "$(plist "$DEST" CFBundleVersion)" == "$BUILD" || "$(state deployed)" == "$SHA" && -n "$(state staged-build)" ]]; then
      if healthy "$rt"; then exit 0; fi
      say "services for $short are down; restarting"; start_services "$rt"; healthy "$rt" || fail services "services for $short do not come up"; exit 0
    fi
    [[ "$(state failed-sha)" != "$SHA" ]] || { say "commit $short failed before ($(state failed-reason)); waiting for a new commit or --force"; exit 0; }
  fi
  LOG="$LOGS/$(date +%Y%m%d-%H%M%S)-$short.log"; exec > >(tee -a "$LOG") 2>&1
  say "updating Development to main $short (build $BUILD)"
  local prev; prev="$(readlink "$RUNTIMES/current" 2>/dev/null || true)"

  # 1. snapshot
  rm -rf "$rt.partial"; mkdir -p "$rt.partial"
  git -C "$REPO" archive "$SHA" | tar -x -C "$rt.partial" || fail snapshot "git archive failed"
  for f in .env.local services/identity-api/.env; do
    [[ -f "$REPO/$f" ]] && { cp -p "$REPO/$f" "$rt.partial/$f"; chmod 600 "$rt.partial/$f"; }
  done
  printf '%s\n' "$SHA" >"$rt.partial/REVISION"
  deps "$rt.partial"
  (cd "$rt.partial" && bin/link >/dev/null && yarn build >/dev/null && yarn build:css >/dev/null) || fail snapshot "web asset build failed"
  rm -rf "$rt"; mv "$rt.partial" "$rt"

  # 2. validate (the Universal typecheck and bundle run inside the Tauri build)
  (cd "$rt" && RAILS_ENV=development bin/rails zeitwerk:check >/dev/null) || fail validate "Rails eager-load check failed"

  # 3. migrate
  migrate "$rt"

  # 4. build
  local built; built="$(build_app "$rt" "$SHA" "$BUILD")"

  # 5. services
  ln -sfn "$rt" "$RUNTIMES/current.new" && mv -fh "$RUNTIMES/current.new" "$RUNTIMES/current"
  start_services "$rt"
  if ! healthy "$rt"; then
    if [[ -n "$prev" && -d "$prev" ]]; then ln -sfn "$prev" "$RUNTIMES/current"; start_services "$prev"; healthy "$prev" || true; fi
    fail services "Development Web did not come up from $short; previous snapshot restarted"
  fi

  # 6. install
  install_app "$built" "$SHA" "$BUILD"
  setstate deployed "$SHA"; setstate failed-sha ""; setstate failed-reason ""
  ls -1d "$RUNTIMES"/*/ 2>/dev/null | sed 's:/$::' | grep -v -e "$rt\$" -e "${prev:-NONE}\$" | while read -r d; do rm -rf "$d"; done || true
  say "Development is at $short: Web from $rt, Dev.app build $BUILD"
  [[ -n "$(state staged-build)" ]] || notify "Updated to build $BUILD" "Development Web and BillieWeather Dev run commit ${SHA:0:8}."
}

status() {
  local d; d="$(state deployed)"
  echo "committed main:     $(git -C "$REPO" rev-parse refs/heads/main) (build $(git -C "$REPO" rev-list --count refs/heads/main))"
  echo "deployed:           ${d:-none}"
  echo "Dev.app:            build $(plist "$DEST" CFBundleVersion), embeds deployed commit: $(embeds "$DEST" "$d" && echo yes || echo no)"
  echo "staged install:     $(state staged-build | sed 's/^$/none/')"
  echo "Web :3000:          $(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/up 2>/dev/null || echo down) from $(cwd_of "$(pid_on 3000)" 2>/dev/null)"
  echo "identity :8100:     $(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8100/health 2>/dev/null || echo down)"
  echo "last failure:       $(state failed-reason | sed 's/^$/none/')"
  echo "agent:              $(launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo loaded || echo 'not loaded')"
  echo "Stable (untouched): $(plist "$STABLE_APP" CFBundleShortVersionString) build $(plist "$STABLE_APP" CFBundleVersion)"
}

install_agent() {
  local dst="$HOME/Library/LaunchAgents/$LABEL.plist" common
  common="$(cd "$(git -C "$REPO" rev-parse --git-common-dir)" && pwd)"
  mkdir -p "$HOME/Library/LaunchAgents"
  sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" -e "s#__GITDIR__#$common#g" \
    "$REPO/ops/launchd/$LABEL.plist.template" >"$dst"
  plutil -lint "$dst" >/dev/null
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
  echo "loaded $LABEL ($dst)"
}

case "${1:-status}" in
  run) run "${2:-}" ;;
  status) status ;;
  install-agent) install_agent ;;
  remove-agent) launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"; echo removed ;;
  *) sed -n 2,7p "$0"; exit 2 ;;
esac
