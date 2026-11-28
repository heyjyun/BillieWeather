#!/usr/bin/env bash
# Run from either Mac's BillieWeather clone.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { printf 'sync-dev-mac: %s\n' "$*" >&2; exit 1; }
[[ "$(git branch --show-current)" == main ]] || fail "switch to main first"
[[ -z "$(git status --porcelain)" ]] || fail "save your working changes before syncing"
before="$(git rev-parse HEAD)"
git fetch origin main
git merge --ff-only FETCH_HEAD
[[ "$(git rev-parse HEAD)" == "$(git rev-parse FETCH_HEAD)" ]] || fail "local main has commits that are absent from GitHub"

for tool in mise uv neon; do
  command -v "$tool" >/dev/null || fail "install $tool using ops/bootstrap-mac-mini.sh"
done
# mise pins the toolchain from the checkout without sourcing dotenv files.
mise install
(cd services/identity-api && uv sync --frozen)
mise exec -- bundle check || mise exec -- bundle install --quiet
if [[ ! -e .env.local && ! -e services/identity-api/.env ]]; then ops/neon-dev-env.sh; fi
ops/neon-dev-env.sh --check
project_ruby="$(mise which ruby)"
PATH="$(dirname "$project_ruby"):$PATH" "$project_ruby" bin/billie-dev-db db:abort_if_pending_migrations
(cd services/identity-api && uv run --no-sync python -m identity_api.schema check)
mise exec -- ops/dev-services.sh check --since "$before" --restart-preview
mise exec -- ops/dev-services.sh preview prepare

installed="${BILLIE_DEV_APP:-/Applications/BillieWeather Dev.app}/Contents/MacOS/billieweather"
revision=""
if [[ -x "$installed" ]] && grep -aq billie-launch-guard-version1 "$installed"; then
  revision="$("$installed" --billie-identity | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).sourceRevision')" || revision=""
fi
if [[ "$revision" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$revision^{commit}" 2>/dev/null && git diff --quiet "$revision" HEAD -- clients/universal packages; then
  printf 'Installed Dev already has the current client sources (%s).\n' "$revision"
else
  mise exec -- ops/install-dev.sh
fi
ops/install-dev.sh --status
