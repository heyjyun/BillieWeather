#!/usr/bin/env bash
# Sets up a BillieWeather development machine (the Mac mini) from nothing but Git.
#   ops/bootstrap-mac-mini.sh            install tools, clone/checkout, install dependencies, verify
#   ops/bootstrap-mac-mini.sh --check    report only; changes nothing
#
# What it never does: copy databases, .env files, Keychain items or anything from another computer;
# write production URLs or secrets; start the shipped app (com.billieweather.client).
# Re-running is safe: each step checks before it acts.
set -euo pipefail

REPO_URL="${BILLIE_REPO_URL:-https://github.com/heyjyun/BillieWeather.git}"
DEV_ROOT="${BILLIE_DEV_ROOT:-$HOME/Developer/BillieWeather}"
BRANCH="${BILLIE_DEV_BRANCH:-main}"
CHECK_ONLY=0; [[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
miss() { printf '  \033[33mneed\033[0m %s\n' "$*"; MISSING=$((MISSING+1)); }
step() { printf '\n== %s\n' "$*"; }
act()  { if (( CHECK_ONLY )); then miss "$1 (would run: $2)"; else printf '  run  %s\n' "$2"; eval "$2"; fi; }
MISSING=0

[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo "Apple Silicon macOS only." >&2; exit 1; }

step "Xcode Command Line Tools (clang, codesign, notarytool, hdiutil is built in)"
if xcode-select -p >/dev/null 2>&1; then ok "$(xcode-select -p)"; else
  miss "Command Line Tools — run: xcode-select --install   (needs a person at the Mac: it opens a dialog)"; fi

step "Homebrew"
if command -v brew >/dev/null; then ok "$(brew --version | head -1)"; else
  miss 'Homebrew — run: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"  (asks for the admin password)'; fi

step "Homebrew packages"
# postgresql@18: the major version CI and production (Neon) use; bin/billie-local takes pg_ctl from PATH
# or BILLIE_PG_BIN. vips: ruby-vips. tmux: long jobs
# survive a closed SSH/Screen Sharing session. Nothing here runs as a background service by default.
BREWS=(git gh mise uv rust postgresql@18 vips redis overmind graphviz sqlite tmux jq)
if command -v brew >/dev/null; then
  for f in "${BREWS[@]}"; do
    bin="$f"; case "$f" in postgresql@18) bin=pg_ctl;; rust) bin=rustc;; vips) bin=vips;; esac
    if brew list --formula "$f" >/dev/null 2>&1 || command -v "$bin" >/dev/null 2>&1; then ok "$f"; else act "$f" "brew install $f"; fi
  done
  if ! command -v pg_ctl >/dev/null; then act "pg_ctl on PATH" "brew link --force postgresql@18"; fi
fi

step "Source"
if [[ -e "$DEV_ROOT/.git" ]]; then ok "$DEV_ROOT"; else
  act "clone" "mkdir -p \"$(dirname "$DEV_ROOT")\" && git clone \"$REPO_URL\" \"$DEV_ROOT\""; fi
if [[ -e "$DEV_ROOT/.git" ]]; then
  cd "$DEV_ROOT"
  git fetch --quiet origin || miss "git fetch failed — authenticate with: gh auth login"
  if git rev-parse --verify --quiet "$BRANCH" >/dev/null; then ok "branch $BRANCH"
  elif git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then act "branch $BRANCH" "git checkout -b $BRANCH origin/$BRANCH"
  else miss "branch $BRANCH is not on GitHub yet — push it from the MacBook (docs/dual-mac/GIT_SYNC.md)"; fi
  for f in .env .env.local .env.development .env.development.local .env.test; do
    [[ -e "$f" ]] && miss "$f exists: bin/billie-local refuses to run beside live dotenv files; move it out"; done
fi

step "Language runtimes (versions pinned by the repository)"
if [[ -e "$DEV_ROOT/.git" ]] && command -v mise >/dev/null; then
  cd "$DEV_ROOT"
  mise which ruby >/dev/null 2>&1 && ok "ruby $(mise exec -- ruby -v | cut -d' ' -f2)" || act "ruby $(cat .ruby-version)" "mise install ruby@$(cat .ruby-version) && mise use ruby@$(cat .ruby-version)"
  mise which node >/dev/null 2>&1 && ok "node $(mise exec -- node -v)" || act "node 24" "mise use node@24"
  command -v rustc >/dev/null && ok "$(rustc -V)" || miss "rustc"
  grep -q '"packageManager": "yarn@' package.json && { command -v corepack >/dev/null || mise exec -- corepack -v >/dev/null 2>&1; } && ok "corepack (yarn from package.json)"
fi

step "Dependencies"
if [[ -e "$DEV_ROOT/.git" ]] && (( ! CHECK_ONLY )); then
  cd "$DEV_ROOT"
  eval "$(mise activate bash)"
  corepack enable
  bundle config set --local path vendor/bundle >/dev/null
  bundle install --quiet                                   && ok "gems"
  yarn install --immutable >/dev/null                      && ok "root JS (yarn)"
  (cd clients/universal && npm ci --no-audit --no-fund >/dev/null) && ok "clients/universal (npm ci)"
  (cd services/identity-api && uv sync --frozen --quiet)  && ok "identity-api (.venv via uv)"
  (cd clients/universal/src-tauri && cargo fetch --quiet)  && ok "Rust crates"
fi

step "Isolated databases (never a shared or production database)"
if [[ -e "$DEV_ROOT/.git" ]]; then
  state="$HOME/.billieweather-dev/local-root"
  if [[ -f "$state" ]] && [[ -d "$(cat "$state")/data" ]]; then ok "cluster $(cat "$state")"
  elif (( ! CHECK_ONLY )); then
    mkdir -p "$(dirname "$state")"; chmod 700 "$(dirname "$state")"
    root="$("$DEV_ROOT/bin/billie-local" init)"; echo "$root" > "$state"
    BILLIE_LOCAL_ROOT="$root" "$DEV_ROOT/bin/billie-local" test-db db:schema:load >/dev/null
    BILLIE_LOCAL_ROOT="$root" "$DEV_ROOT/bin/billie-local" rails db:schema:load >/dev/null
    BILLIE_LOCAL_ROOT="$root" "$DEV_ROOT/bin/billie-local" identity -m identity_api.schema migrate >/dev/null
    ok "cluster $root (development + test schemas, identity schema)"
  else miss "isolated cluster (would run: bin/billie-local init)"; fi
  echo "  note: /tmp is cleared at reboot; ops/dev-services.sh start re-creates the cluster when it is gone."
fi

step "Permissions a person must grant on this Mac (System Settings > Privacy & Security)"
echo "  Accessibility + Screen Recording: the terminal / Claude Code / Codex app that runs native GUI tests"
echo "  Remote Login (SSH) and Screen Sharing: System Settings > General > Sharing"

printf '\n%s\n' "$( (( MISSING )) && echo "$MISSING item(s) need attention (see 'need' lines)." || echo "Bootstrap complete. Next: ops/doctor.sh" )"
