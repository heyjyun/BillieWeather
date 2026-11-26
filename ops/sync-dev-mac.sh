#!/usr/bin/env bash
# Run from either Mac's BillieWeather clone.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { printf 'sync-dev-mac: %s\n' "$*" >&2; exit 1; }
[[ "$(git branch --show-current)" == main ]] || fail "switch to main first"
[[ -z "$(git status --porcelain)" ]] || fail "save your working changes before syncing"
git fetch origin main
git merge --ff-only FETCH_HEAD

for tool in mise uv neon npm; do
  command -v "$tool" >/dev/null || fail "install $tool using ops/bootstrap-mac-mini.sh"
done
# mise pins the toolchain from the checkout without sourcing dotenv files.
mise install
mise exec -- bash -c 'cd clients/universal && npm ci --no-audit --no-fund'
(cd services/identity-api && uv sync --frozen)
mise exec -- bundle check || mise exec -- bundle install --quiet
ops/neon-dev-env.sh
ops/neon-dev-env.sh --check
mise exec -- ruby bin/billie-dev-db db:abort_if_pending_migrations
mise exec -- ops/install-dev.sh
ops/install-dev.sh --status
