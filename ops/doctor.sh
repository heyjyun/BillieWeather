#!/usr/bin/env bash
# Proves this Mac can develop, test and build BillieWeather on its own, and that it cannot touch
# real data.  ops/doctor.sh [--tests] [--build]
#   (no flag)  tools, isolation and independence checks only (fast, read-only)
#   --tests    + Rails, frontend, Rust and identity-api suites against the isolated cluster
#   --build    + a QA app build (never the shipped identifier)
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0; pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }; bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
chk() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$label"; else bad "$label"; fi; }
eval "$(mise activate bash 2>/dev/null)" || true

echo "== Tools"
chk "ruby $(cat .ruby-version)"          bash -c '[[ "$(ruby -e "print RUBY_VERSION")" == "$(cat .ruby-version)" ]]'
chk "node 24+"                            bash -c '[[ "$(node -p "process.versions.node.split(\".\")[0]")" -ge 24 ]]'
chk "rustc >= 1.94"                       bash -c 'v=$(rustc -V | cut -d" " -f2); [[ "$(printf "%s\n1.94.0\n" "$v" | sort -V | head -1)" == 1.94.0 ]]'
chk "uv + identity-api .venv"             test -x services/identity-api/.venv/bin/python
chk "pg_ctl (PostgreSQL)"                 command -v pg_ctl
chk "sqlite3, hdiutil, codesign, shasum"  bash -c 'command -v sqlite3 && command -v hdiutil && command -v codesign && command -v shasum'
chk "frontend dependencies"               test -d clients/universal/node_modules
chk "gems"                                bundle check

echo "== Independence (nothing from the MacBook)"
chk "no .env files in the checkout"       bash -c '! ls .env .env.* 2>/dev/null | grep -v example'
chk "no database URL in the shell"        bash -c '[[ -z "${DATABASE_URL:-}${DATABASE_URL_UNPOOLED:-}${PRIMARY_DATABASE_URL:-}" ]]'
chk "no Neon host in shell environment"   bash -c '! env | grep -qi "neon.tech"'
chk "no MacBook hostnames in config"      bash -c '! git grep -nIE "MacBook|\.local:[0-9]+|100\.[0-9]+\.[0-9]+\.[0-9]+:" -- config clients/universal/src clients/universal/scripts ops bin'
chk "shipped app data absent on this Mac" bash -c '[[ ! -e "$HOME/Library/Application Support/com.billieweather.client/billieweather.db" ]]'
chk "isolated backend up (ops/dev-services.sh start)" bash -c 'curl -fsS -o /dev/null http://127.0.0.1:38530/up && curl -fsS -o /dev/null http://127.0.0.1:38531/health'
if [[ -f "$HOME/.billieweather-dev/local-root" ]]; then
  export BILLIE_LOCAL_ROOT; BILLIE_LOCAL_ROOT="$(cat "$HOME/.billieweather-dev/local-root")"
  chk "cluster is socket-only and verified" bin/billie-local verify
fi

if [[ " $* " == *" --tests "* ]]; then
  echo "== Test suites (isolated cluster, synthetic fixtures)"
  chk "Rails"            bin/billie-local test
  chk "frontend (vitest)" bash -c 'cd clients/universal && npx vitest run'
  chk "typecheck"        bash -c 'cd clients/universal && npm run -s typecheck'
  chk "Rust (cargo test)" bash -c 'cd clients/universal/src-tauri && cargo test --quiet'
  U="postgresql:///billie_isolated_test?host=$BILLIE_LOCAL_ROOT/socket&port=35531&user=billie_isolated"
  chk "identity-api (pytest)" bash -c "cd services/identity-api && env -i HOME=\"$HOME\" PATH=\"$PATH\" IDENTITY_TEST_DATABASE_URL='$U' IDENTITY_RAILS_COMPAT=1 IDENTITY_ENV=test .venv/bin/python -m pytest -q -p no:warnings"
fi

if [[ " $* " == *" --build "* ]]; then
  echo "== QA build (com.billieweather.client.qa.*, never the shipped app)"
  chk "QA app builds and passes preflight" bash -c 'cd clients/universal && BILLIE_QA_API_URL=http://127.0.0.1:38530 BILLIE_QA_IDENTITY_URL=http://127.0.0.1:38531 node scripts/qa.mjs build doctor'
fi

echo; (( FAIL )) && { echo "$FAIL check(s) failed."; exit 1; } || echo "All checks passed."
