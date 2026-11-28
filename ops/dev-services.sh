#!/usr/bin/env bash
# Isolated backend for development and QA on this Mac: a private PostgreSQL cluster (Unix socket
# only, no TCP), Rails on 127.0.0.1:38530 and identity-api on 127.0.0.1:38531.
#   ops/dev-services.sh start|stop|status|reset
# The browser preview (Vite on localhost:1420, clients/universal; in-memory database, keeps nothing):
#   ops/dev-services.sh preview start|stop|restart|status
#   ops/dev-services.sh preview check [--restart-if-stale]   after a pull (git-sync.sh, sync-dev-mac.sh)
# Every process gets its database URL from bin/billie-local, which verifies the cluster before it
# starts anything. No .env file, no Neon URL, no shared port: the stack cannot reach real data.
set -euo pipefail
cd "$(dirname "$0")/.."
STATE="$HOME/.billieweather-dev"; mkdir -p "$STATE/logs"; chmod 700 "$STATE"
API_PORT=38530; ID_PORT=38531

root() {
  local r; r="$(cat "$STATE/local-root" 2>/dev/null || true)"
  if [[ -z "$r" || ! -d "$r/data" ]]; then   # /tmp is emptied at reboot: make a fresh cluster
    r="$(bin/billie-local init)"; echo "$r" > "$STATE/local-root"
    BILLIE_LOCAL_ROOT="$r" bin/billie-local rails db:schema:load >/dev/null
    BILLIE_LOCAL_ROOT="$r" bin/billie-local test-db db:schema:load >/dev/null
    echo "new isolated cluster: $r" >&2
  fi
  # identity-api keeps its own additive schema; without it /health stays 503. Idempotent.
  BILLIE_LOCAL_ROOT="$r" bin/billie-local start >/dev/null 2>&1 || true
  BILLIE_LOCAL_ROOT="$r" bin/billie-local identity -m identity_api.schema migrate >/dev/null
  echo "$r"
}
up() { curl -fsS -o /dev/null "http://127.0.0.1:$1$2" 2>/dev/null; }
pid_on() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }   # empty, not a failure, when nothing listens

# --- Browser preview -------------------------------------------------------------------------------
# Only a Vite process started from THIS checkout's clients/universal is ever stopped or restarted. A
# restart keeps the running server's VITE_BILLIE_* URLs; a first start uses BILLIE_PREVIEW_API_URL /
# BILLIE_PREVIEW_IDENTITY_URL, else the isolated stack above. Nothing here touches any database: the
# preview's SQLite is in memory and is rebuilt from src-tauri/migrations on every page load.
APP="$PWD/clients/universal"; PREVIEW_PORT=1420
started_epoch() { LC_ALL=C date -j -f "%a %b %d %T %Y" "$(LC_ALL=C ps -o lstart= -p "$1" | sed 's/  */ /g;s/^ //')" +%s 2>/dev/null || echo 0; }
head_moved() { git log -g -1 --format=%ct HEAD 2>/dev/null || echo 0; }   # when this checkout last changed commit
preview_pid() {   # the Vite on :1420, only if it runs from this checkout
  local pid cwd; pid="$(pid_on $PREVIEW_PORT)"; [[ -n "$pid" ]] || return 1
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  [[ "$cwd" == "$APP" ]] && ps -o command= -p "$pid" | grep -q 'node_modules/.bin/vite' && echo "$pid"
}
preview_env() { ps eww -o command= -p "$1" 2>/dev/null | tr ' ' '\n' | grep -E "^$2=" | head -1 | cut -d= -f2-; }
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
# Prints "ok", "stale <reason>", "down" or "foreign <pid>"
preview_state() {
  local pid json; pid="$(pid_on $PREVIEW_PORT)"; [[ -n "$pid" ]] || { echo down; return; }
  preview_pid >/dev/null || { echo "foreign $pid"; return; }
  if deps_outdated; then echo "stale node_modules is older than package-lock.json (npm ci needed)"; return; fi
  json="$(curl -fsS --max-time 3 "http://localhost:$PREVIEW_PORT/__billie/dev-status" 2>/dev/null || true)"
  if [[ "$json" != "{"* ]]; then echo "stale started before migration watching existed (no /__billie/dev-status)"; return; fi
  if [[ "$json" == *'"stale":true'* ]]; then echo "stale $(printf '%s' "$json" | sed -n 's/.*"reasons":\["\([^"]*\)".*/\1/p')"; return; fi
  echo ok
}
preview_stop() {
  local pid; pid="$(preview_pid)" || { [[ -z "$(pid_on $PREVIEW_PORT)" ]] && return 0; echo "port $PREVIEW_PORT is held by another program (pid $(pid_on $PREVIEW_PORT)): not stopped" >&2; return 1; }
  kill -TERM "$pid"
  for _ in $(seq 1 20); do [[ -z "$(pid_on $PREVIEW_PORT)" ]] && return 0; sleep 0.5; done
  echo "the preview (pid $pid) did not stop within 10 s" >&2; return 1
}
preview_start() {
  local api="${1:-${BILLIE_PREVIEW_API_URL:-http://127.0.0.1:$API_PORT}}" identity="${2:-${BILLIE_PREVIEW_IDENTITY_URL:-http://127.0.0.1:$ID_PORT}}"
  [[ -z "$(pid_on $PREVIEW_PORT)" ]] || { echo "port $PREVIEW_PORT is in use (pid $(pid_on $PREVIEW_PORT))" >&2; return 1; }
  if deps_outdated; then echo "installing clients/universal dependencies (npm ci)…"; (cd "$APP" && npm ci --no-audit --no-fund >>"$STATE/logs/vite.log" 2>&1); fi
  # Detached from this script's stdin/stdout, so a caller that pipes the output (… | tail) is not held open.
  (cd "$APP" && VITE_BILLIE_API_URL="$api" VITE_BILLIE_IDENTITY_URL="$identity" exec nohup npx vite) </dev/null >>"$STATE/logs/vite.log" 2>&1 &
  for _ in $(seq 1 60); do curl -fs -o /dev/null --max-time 2 "http://localhost:$PREVIEW_PORT/__billie/dev-status" && break; sleep 0.5; done
  echo "preview  http://localhost:$PREVIEW_PORT  api $api  identity $identity  (log $STATE/logs/vite.log)"
}
preview_restart() {
  local pid api="" identity=""
  if pid="$(preview_pid)"; then api="$(preview_env "$pid" VITE_BILLIE_API_URL)"; identity="$(preview_env "$pid" VITE_BILLIE_IDENTITY_URL)"; fi
  preview_stop && preview_start "$api" "$identity"
}
preview() {
  local state
  case "${1:-status}" in
    start) [[ "$(preview_state)" == down ]] && preview_start || "$0" preview status ;;
    stop) preview_stop && echo "preview stopped" ;;
    restart) preview_restart ;;
    status|check)
      state="$(preview_state)"
      case "$state" in
        down) echo "preview  not running (ops/dev-services.sh preview start)" ;;
        foreign*) echo "preview  port $PREVIEW_PORT is held by another program (pid ${state#foreign }), not this checkout's Vite" ;;
        ok) echo "preview  http://localhost:$PREVIEW_PORT  up to date (pid $(preview_pid))" ;;
        stale*)
          echo "preview  STALE: ${state#stale }"
          if [[ "$1" == check && "${2:-}" == --restart-if-stale ]]; then echo "preview  restarting it (in-memory database only; no data involved)"; preview_restart
          else echo "         fix: ops/dev-services.sh preview restart"; fi ;;
      esac
      for port in $API_PORT $ID_PORT 3000 8100; do   # servers that do not reload every change by themselves
        local pid; pid="$(pid_on $port)"; [[ -n "$pid" ]] || continue
        (( $(started_epoch "$pid") < $(head_moved) )) && echo "note     the server on :$port (pid $pid) started before this checkout last changed commit; restart it if the pull touched its code"
      done
      return 0 ;;
    *) echo "usage: $0 preview start|stop|restart|status|check [--restart-if-stale]" >&2; return 2 ;;
  esac
}

case "${1:-status}" in
  start)
    export BILLIE_LOCAL_ROOT; BILLIE_LOCAL_ROOT="$(root)"
    bin/billie-local start >/dev/null 2>&1 || true      # already running is fine
    bin/billie-local verify
    up $API_PORT /up || nohup bin/billie-local rails server -b 127.0.0.1 -p $API_PORT >>"$STATE/logs/rails.log" 2>&1 &
    up $ID_PORT /health || nohup bin/billie-local identity -m uvicorn identity_api.main:app \
      --host 127.0.0.1 --port $ID_PORT --no-access-log >>"$STATE/logs/identity.log" 2>&1 &
    for _ in $(seq 1 60); do up $API_PORT /up && up $ID_PORT /health && break; sleep 2; done
    "$0" status ;;
  stop)
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
  *) echo "usage: $0 start|stop|status|reset|preview …" >&2; exit 2 ;;
esac
