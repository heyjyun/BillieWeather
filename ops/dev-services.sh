#!/usr/bin/env bash
# Isolated backend for development and QA on this Mac: a private PostgreSQL cluster (Unix socket
# only, no TCP), Rails on 127.0.0.1:38530 and identity-api on 127.0.0.1:38531.
#   ops/dev-services.sh start|stop|status|reset
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
  echo "$r"
}
up() { curl -fsS -o /dev/null "http://127.0.0.1:$1$2" 2>/dev/null; }
pid_on() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }

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
    echo "QA builds: BILLIE_QA_API_URL=http://127.0.0.1:$API_PORT BILLIE_QA_IDENTITY_URL=http://127.0.0.1:$ID_PORT" ;;
  reset)  # throw the synthetic data away and start clean
    "$0" stop; r="$(cat "$STATE/local-root" 2>/dev/null || true)"
    [[ "$r" =~ ^(/private)?/tmp/billie-roadmap\.[[:alnum:]]+$ ]] && rm -rf "$r"; rm -f "$STATE/local-root"
    "$0" start ;;
  *) echo "usage: $0 start|stop|status|reset" >&2; exit 2 ;;
esac
