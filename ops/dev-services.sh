#!/usr/bin/env bash
# Isolated backend for development and QA on this Mac: a private PostgreSQL cluster (Unix socket
# only, no TCP), Rails on 127.0.0.1:38530 and identity-api on 127.0.0.1:38531.
#   ops/dev-services.sh start|stop|status|reset
# The browser preview (Vite on localhost:1420, clients/universal; in-memory database, keeps nothing):
#   ops/dev-services.sh preview start|stop|restart|status
#   ops/dev-services.sh preview check [--restart-if-stale]   after a pull (git-sync.sh, sync-dev-mac.sh)
#   ops/dev-services.sh check [--since COMMIT] [--restart-preview]
# Every process gets its database URL from bin/billie-local, which verifies the cluster before it
# starts anything. No .env file, no Neon URL, no shared port: the stack cannot reach real data.
set -euo pipefail
cd "$(dirname "$0")/.."
STATE="$HOME/.billieweather-dev"; mkdir -p "$STATE/logs"; chmod 700 "$STATE"
API_PORT=38530; ID_PORT=38531

root() {
  local r; r="$(cat "$STATE/local-root" 2>/dev/null || true)"
  if [[ -z "$r" || ! -d "$r/data" ]]; then   # /tmp is emptied at reboot: make a fresh cluster
    r="$(bin/billie-local init)" || return
    BILLIE_LOCAL_ROOT="$r" bin/billie-local rails db:schema:load >/dev/null || return
    BILLIE_LOCAL_ROOT="$r" bin/billie-local test-db db:schema:load >/dev/null || return
    echo "$r" > "$STATE/local-root"
    echo "new isolated cluster: $r" >&2
  fi
  echo "$r"
}
up() { curl -fsS -o /dev/null "http://127.0.0.1:$1$2" 2>/dev/null; }
pid_on() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }   # empty, not a failure, when nothing listens
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

isolated_owner() {
  local owner; owner="$(cat "$STATE/local-checkout" 2>/dev/null || true)"
  [[ -z "$owner" || "$owner" == "$PWD" ]] || { echo "isolated development cluster belongs to another checkout: $owner" >&2; return 1; }
  local port pid expected command
  for port in "$API_PORT" "$ID_PORT"; do
    pid="$(pid_on "$port")"; [[ -n "$pid" ]] || continue
    if [[ "$port" == "$API_PORT" ]]; then expected="$PWD"; command=puma
    else expected="$(cat "$STATE/local-root" 2>/dev/null || true)/identity"; command=identity_api.main:app; fi
    if [[ "$(cwd_of "$pid")" != "$expected" || "$(ps -o command= -p "$pid")" != *"$command"* ]]; then
      echo "isolated port $port is occupied by another process (pid $pid)" >&2
      return 1
    fi
  done
}

# --- Browser preview -------------------------------------------------------------------------------
# Only a Vite process started from THIS checkout's clients/universal is ever stopped or restarted. A
# restart keeps the running server's VITE_BILLIE_* URLs; a first start uses BILLIE_PREVIEW_API_URL /
# BILLIE_PREVIEW_IDENTITY_URL, else the isolated stack above. Nothing here touches any database: the
# preview's SQLite is in memory and is rebuilt from src-tauri/migrations on every page load.
APP="$PWD/clients/universal"; PREVIEW_PORT="${BILLIE_PREVIEW_PORT:-1420}"   # another port only for tests of this script
started_epoch() { LC_ALL=C date -j -f "%a %b %d %T %Y" "$(LC_ALL=C ps -o lstart= -p "$1" | sed 's/  */ /g;s/^ //')" +%s 2>/dev/null || echo 0; }
head_moved() { git log -g -1 --format=%ct HEAD 2>/dev/null || echo 0; }   # when this checkout last changed commit
preview_pid() {   # the Vite on :1420, only if it runs from this checkout
  local pid cwd; pid="$(pid_on $PREVIEW_PORT)"; [[ -n "$pid" ]] || return 1
  cwd="$(cwd_of "$pid")"
  [[ "$cwd" == "$APP" ]] && ps -o command= -p "$pid" | grep -Eq 'node_modules/(\.bin/vite|vite/bin/vite\.js)' && echo "$pid"
}
preview_env() { ps eww -o command= -p "$1" 2>/dev/null | tr ' ' '\n' | grep -E "^$2=" | head -1 | cut -d= -f2-; }
managed_preview() { [[ "$(preview_env "$1" BILLIE_MANAGED_PREVIEW)" == 1 ]]; }
# True when node_modules differs from package-lock.json: a package missing (optional platform builds
# aside), extra, or at another version. Compares contents; a pull that rewrites the file unchanged is fine.
deps_outdated() {
  [[ -f "$APP/node_modules/.package-lock.json" ]] || return 0
  (cd "$APP" && node -e '
    const lock = require("./package-lock.json").packages, installed = require("./node_modules/.package-lock.json").packages;
    const drift = Object.entries(lock).some(([path, entry]) => path && (installed[path] ? installed[path].version !== entry.version : !entry.optional))
      || Object.keys(installed).some((path) => !lock[path]);
    process.exit(drift ? 0 : 1);') 2>/dev/null
}
prepare_preview() {
  if deps_outdated; then
    if [[ -n "$(pid_on "$PREVIEW_PORT")" ]]; then echo "stop the preview with its original launch method before changing dependencies" >&2; return 1; fi
    echo "installing clients/universal dependencies (npm ci)…"
    (cd "$APP" && npm ci --no-audit --no-fund >>"$STATE/logs/vite.log" 2>&1)
  fi
}
# Prints "ok", "stale <reason>", "down" or "foreign <pid>"
preview_state() {
  local pid json; pid="$(pid_on $PREVIEW_PORT)"; [[ -n "$pid" ]] || { echo down; return; }
  preview_pid >/dev/null || { echo "foreign $pid"; return; }
  if deps_outdated; then echo "stale node_modules is older than package-lock.json (npm ci needed)"; return; fi
  json="$(curl -fsS --max-time 3 "http://localhost:$PREVIEW_PORT/__billie/dev-status" 2>/dev/null || true)"
  printf '%s' "$json" | node -e '
    try {
      const status = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      if (!status.migrationDigest || !status.catalog?.digest) throw new Error();
      console.log(status.stale ? "stale " + status.reasons.join(", ") : "ok");
    } catch { console.log("stale server does not report current migration and catalog fingerprints"); }
  '
}
preview_stop() {
  local pid; pid="$(preview_pid)" || { [[ -z "$(pid_on $PREVIEW_PORT)" ]] && return 0; echo "port $PREVIEW_PORT is held by another program (pid $(pid_on $PREVIEW_PORT)): not stopped" >&2; return 1; }
  managed_preview "$pid" || { echo "preview pid $pid was started manually; stop it using its original command" >&2; return 1; }
  kill -TERM "$pid"
  for _ in $(seq 1 20); do [[ -z "$(pid_on $PREVIEW_PORT)" ]] && return 0; sleep 0.5; done
  echo "the preview (pid $pid) did not stop within 10 s" >&2; return 1
}
preview_start() {
  local api="${1:-${BILLIE_PREVIEW_API_URL:-http://127.0.0.1:$API_PORT}}" identity="${2:-${BILLIE_PREVIEW_IDENTITY_URL:-http://127.0.0.1:$ID_PORT}}"
  local sync="${3:-${VITE_BILLIE_MODULE_SYNC:-1}}"
  [[ -z "$(pid_on $PREVIEW_PORT)" ]] || { echo "port $PREVIEW_PORT is in use (pid $(pid_on $PREVIEW_PORT))" >&2; return 1; }
  prepare_preview
  # A separate process group survives the launching shell and its pipes closing.
  BILLIE_MANAGED_PREVIEW=1 TAURI_DEV_HOST= VITE_BILLIE_API_URL="$api" VITE_BILLIE_IDENTITY_URL="$identity" VITE_BILLIE_MODULE_SYNC="$sync" node -e '
    const [cwd, port, log] = process.argv.slice(1);
    const fd = require("node:fs").openSync(log, "a");
    const keys = ["HOME", "PATH", "TMPDIR", "BILLIE_MANAGED_PREVIEW", "TAURI_DEV_HOST", "VITE_BILLIE_API_URL", "VITE_BILLIE_IDENTITY_URL", "VITE_BILLIE_MODULE_SYNC"];
    const env = Object.fromEntries(keys.filter((key) => key in process.env).map((key) => [key, process.env[key]]));
    const vite = require("node:child_process").spawn(process.execPath, [cwd + "/node_modules/vite/bin/vite.js", "--port", port, "--strictPort"], {cwd, env, detached: true, stdio: ["ignore", fd, fd]});
    vite.unref();
  ' "$APP" "$PREVIEW_PORT" "$STATE/logs/vite.log"
  for _ in $(seq 1 60); do
    if [[ "$(preview_state)" == ok ]]; then echo "preview  http://localhost:$PREVIEW_PORT  (log $STATE/logs/vite.log)"; return; fi
    sleep 0.5
  done
  echo "preview did not become ready; see $STATE/logs/vite.log" >&2
  return 1
}
preview_restart() {
  local pid api="" identity="" sync=""
  if pid="$(preview_pid)" && managed_preview "$pid"; then
    api="$(preview_env "$pid" VITE_BILLIE_API_URL)"; identity="$(preview_env "$pid" VITE_BILLIE_IDENTITY_URL)"; sync="$(preview_env "$pid" VITE_BILLIE_MODULE_SYNC)"
  fi
  preview_stop && preview_start "$api" "$identity" "$sync"
}
preview() {
  local state
  case "${1:-status}" in
    start) [[ "$(preview_state)" == down ]] && preview_start || "$0" preview status ;;
    stop) preview_stop && echo "preview stopped" ;;
    restart) preview_restart ;;
    prepare) prepare_preview ;;
    status|check)
      state="$(preview_state)"
      case "$state" in
        down) echo "preview  not running (ops/dev-services.sh preview start)" ;;
        foreign*) echo "preview  port $PREVIEW_PORT is held by another program (pid ${state#foreign }), not this checkout's Vite" ;;
        ok) echo "preview  http://localhost:$PREVIEW_PORT  up to date (pid $(preview_pid))" ;;
        stale*)
          echo "preview  STALE: ${state#stale }"
          if [[ "$1" == check && "${2:-}" == --restart-if-stale ]] && managed_preview "$(preview_pid)"; then echo "preview  restarting the managed preview"; preview_restart || return
          elif managed_preview "$(preview_pid)"; then echo "         fix: ops/dev-services.sh preview restart"
          else echo "         restart this manually launched preview using its original command"; fi
          if [[ "$1" == check && "$(preview_state)" != ok ]]; then return 1; fi ;;
      esac
      return 0 ;;
    *) echo "usage: $0 preview start|stop|restart|status|check [--restart-if-stale]" >&2; return 2 ;;
  esac
}

backend_status() {
  local since="${1:-}" port pid cwd sandbox response paths
  local failed=0
  sandbox="$(cat "$STATE/local-root" 2>/dev/null || true)"
  for port in "$API_PORT" 3000 "$ID_PORT" 8100; do
    pid="$(pid_on "$port")"; [[ -n "$pid" ]] || continue
    cwd="$(cwd_of "$pid")"
    if [[ "$cwd" != "$PWD" && "$cwd" != "$PWD/"* && "$cwd" != "$sandbox/identity" ]]; then
      echo "port $port is served by another checkout (pid $pid); left alone"
      continue
    fi
    if [[ "$port" == "$API_PORT" || "$port" == 3000 ]]; then
      response="$(curl -sS --max-time 6 "http://127.0.0.1:$port/__billie/dev-status" 2>/dev/null || true)"
      if ! printf '%s' "$response" | node -e '
        try {
          const fs = require("node:fs");
          const live = JSON.parse(fs.readFileSync(0, "utf8"));
          const catalog = JSON.parse(fs.readFileSync("packages/shared-types/schema/module-catalog.json", "utf8"));
          const digest = require("node:crypto").createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
          const matching = live.catalog.version === catalog.version && live.catalog.digest === digest;
          console.log(`rails    :${process.argv[1]} schema ${live.schema.version}/${live.schema.expected}, catalog ${live.catalog.version}/${catalog.version}, module API format ${live.module_sync.format} (${live.module_sync.enabled ? "enabled" : "disabled"})`);
          if (!live.ready) console.log(`         pending: ${live.schema.pending.join(", ") || "none"}; missing tables: ${live.schema.missing_tables.join(", ") || "none"}`);
          if (!matching) console.log("         live module catalog differs from this checkout; inspect/restart Rails with its original launch command");
          if (live.module_sync.format !== 2) console.log("         client module preference API format differs from the expected format 2");
          process.exitCode = live.ready && matching && live.module_sync.format === 2 ? 0 : 1;
        } catch {
          console.log(`rails    :${process.argv[1]} runtime comparison unavailable; check its startup, logs and database migrations`);
          process.exitCode = 1;
        }
      ' "$port"; then failed=1; fi
      paths=(app config db lib Gemfile Gemfile.lock packages/shared-types/schema/module-catalog.json)
    else
      if up "$port" /health; then echo "identity :$port schema ready at startup"; else echo "identity :$port not ready; check /health and the original launch log"; failed=1; fi
      paths=(services/identity-api)
      if [[ -n "$since" ]] && ! git diff --quiet "$since" HEAD -- services/identity-api/identity_api/migrations; then
        echo "         Identity migration files changed; run identity_api.schema check with its verified development settings"
      fi
    fi
    if (( $(started_epoch "$pid") < $(head_moved) )) && { [[ -z "$since" ]] || ! git diff --quiet "$since" HEAD -- "${paths[@]}"; }; then
      echo "         pid $pid predates relevant checkout changes; preserve its original launch command if a restart is needed"
    fi
  done
  return "$failed"
}

check_runtime() {
  local since="" restart="" edits="" failed=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since) since="$(git rev-parse --verify "${2:?--since needs a commit}^{commit}")" || return 1; shift ;;
      --restart-preview) restart=--restart-if-stale ;;
      *) echo "usage: $0 check [--since COMMIT] [--restart-preview]" >&2; return 2 ;;
    esac
    shift
  done
  if [[ -n "$since" ]]; then
    edits="$(git diff --name-only --no-renames --diff-filter=MD "$since" HEAD -- 'db/migrate/*.rb' 'clients/universal/src-tauri/migrations/*.sql' 'services/identity-api/identity_api/migrations/*.sql')"
    if [[ -n "$edits" ]]; then
      printf 'Existing migration files changed. Review compatibility with applied databases before upgrading:\n%s\n' "$edits"
      failed=1
    fi
  fi
  preview check "$restart" || failed=1
  backend_status "$since" || failed=1
  return "$failed"
}

case "${1:-status}" in
  start)
    isolated_owner
    for dotenv in .env .env.local .env.development .env.development.local .env.test .env.test.local; do
      if [[ -e "$dotenv" || -L "$dotenv" ]]; then echo "use a checkout without $dotenv for the isolated stack" >&2; exit 1; fi
    done
    BILLIE_LOCAL_ROOT="$(root)"
    export BILLIE_LOCAL_ROOT
    bin/billie-local start >/dev/null 2>&1 || true      # already running is fine
    bin/billie-local verify
    bin/billie-local rails db:abort_if_pending_migrations
    # Only this verified private cluster receives Identity's additive local migration.
    bin/billie-local identity -m identity_api.schema migrate
    printf '%s\n' "$PWD" > "$STATE/local-checkout"
    up $API_PORT /up || nohup bin/billie-local rails server -b 127.0.0.1 -p $API_PORT >>"$STATE/logs/rails.log" 2>&1 &
    up $ID_PORT /health || nohup bin/billie-local identity -m uvicorn identity_api.main:app \
      --host 127.0.0.1 --port $ID_PORT --no-access-log >>"$STATE/logs/identity.log" 2>&1 &
    for _ in $(seq 1 25); do
      if up $API_PORT /up && up $ID_PORT /health; then "$0" status; exit $?; fi
      sleep 2
    done
    echo "isolated services did not become ready; see $STATE/logs/rails.log and $STATE/logs/identity.log" >&2
    exit 1 ;;
  stop)
    isolated_owner
    for p in $API_PORT $ID_PORT; do pid="$(pid_on $p)"; [[ -n "$pid" ]] && kill "$pid" || true; done
    r="$(cat "$STATE/local-root" 2>/dev/null || true)"
    [[ -n "$r" && -d "$r/data" ]] && BILLIE_LOCAL_ROOT="$r" bin/billie-local stop >/dev/null 2>&1 || true
    echo "stopped" ;;
  status)
    r="$(cat "$STATE/local-root" 2>/dev/null || echo none)"; echo "cluster  $r"
    up $API_PORT /up     && echo "rails    http://127.0.0.1:$API_PORT  up" || echo "rails    down"
    up $ID_PORT /health  && echo "identity http://127.0.0.1:$ID_PORT  up" || echo "identity down"
    preview status
    echo "QA builds: BILLIE_QA_API_URL=http://127.0.0.1:$API_PORT BILLIE_QA_IDENTITY_URL=http://127.0.0.1:$ID_PORT" ;;
  reset)  # throw the synthetic data away and start clean
    "$0" stop; r="$(cat "$STATE/local-root" 2>/dev/null || true)"
    [[ "$r" =~ ^(/private)?/tmp/billie-roadmap\.[[:alnum:]]+$ ]] && rm -rf "$r"; rm -f "$STATE/local-root"
    "$0" start ;;
  preview) shift; preview "$@" ;;
  check) shift; check_runtime "$@" ;;
  *) echo "usage: $0 start|stop|status|reset|preview|check …" >&2; exit 2 ;;
esac
