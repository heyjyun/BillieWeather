#!/usr/bin/env bash
# Safe Git synchronization between the two Macs through GitHub.
#   ops/git-sync.sh status            what is ahead/behind on every branch; uncommitted work
#   ops/git-sync.sh check [range]     scan what would be pushed for secrets, data and build output
#   ops/git-sync.sh push <branch>     check, then push that one branch (never --force, never tags implicitly)
#   ops/git-sync.sh pull              fetch and fast-forward the current branch only
# Pushing needs the owner's authorization and `gh auth login` on that Mac.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { printf 'git-sync: %s\n' "$*" >&2; exit 1; }

# Paths that never belong on GitHub, whatever .gitignore says.
FORBIDDEN='(\.(db|sqlite3?|db-wal|db-shm|bak|dmg|p12|pem|key|keychain|mobileprovision)$)|(^|/)\.env(\..+)?$|(^|/)(master\.key|credentials\.json|device-identity\.json)$|(^|/)(target|node_modules|dist|coverage|log|tmp)/|(^|/)Statements?/|\.app/'
# Content that looks like a credential or real connection string.
SECRETS='(sk-(proj-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|npg_[A-Za-z0-9]{10,}|postgres(ql)?://[^ "'"'"'@/]+:[^ "'"'"'@/]+@|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|POSTMARK_API_TOKEN=[^ ]{8,}|OPENAI_API_KEY=[^ ]{8,})'

ALLOW="$(grep -vE '^(#|$)' ops/git-sync.allow 2>/dev/null || true)"
allow() { if [[ -n "$ALLOW" ]]; then grep -vE -f <(echo "$ALLOW") || true; else cat; fi; }
check() {
  local range="$1" bad=0 files hits
  files="$(git diff --name-only --diff-filter=AM "$range" 2>/dev/null || true)"
  [[ -n "$files" ]] || { echo "nothing new in $range"; return 0; }
  if echo "$files" | grep -E "$FORBIDDEN" | grep -v '\.env\.example$' | allow | grep .; then echo "^ data, keys or build output — not pushed"; bad=1; fi
  hits="$(git diff "$range" -U0 | grep -E '^\+' | grep -v '^+++' | grep -nE "$SECRETS" | allow || true)"
  [[ -z "$hits" ]] || { echo "$hits" | head -5 | cut -c1-120; echo "^ looks like a credential — not pushed"; bad=1; }
  while read -r f; do
    [[ -f "$f" ]] || continue
    s=$(stat -f %z "$f"); (( s > 5*1024*1024 )) && { echo "large file ($((s/1024/1024)) MB): $f"; bad=1; }
  done <<<"$files"
  if command -v gitleaks >/dev/null; then gitleaks git --no-banner --log-opts="$range" . || bad=1; fi
  (( bad )) && return 1; echo "clean: $(echo "$files" | wc -l | tr -d ' ') file(s) in $range"
}

case "${1:-status}" in
  status)
    git fetch --quiet origin 2>/dev/null || echo "(offline or not authenticated: showing last known remote state)"
    printf '%-32s %s\n' BRANCH "AHEAD/BEHIND origin"
    for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
      if git rev-parse -q --verify "origin/$b" >/dev/null; then ab="$(git rev-list --left-right --count "$b...origin/$b" | awk '{print "+"$1" -"$2}')"; else ab="not on GitHub"; fi
      printf '%-32s %s\n' "$b" "$ab"; done
    n="$(git status --porcelain | wc -l | tr -d ' ')"; echo "uncommitted changes in this checkout: $n" ;;
  check) check "${2:-origin/main..HEAD}" ;;
  push)
    b="${2:?branch}"; base="origin/$b"; git rev-parse -q --verify "$base" >/dev/null || base="origin/main"
    check "$base..$b" || die "fix the findings first"
    git push origin "$b:$b" ;;
  pull)
    [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "commit or set aside local changes first"
    before="$(git rev-parse HEAD)"
    git fetch origin && git merge --ff-only "origin/$(git branch --show-current)"
    ops/dev-services.sh check --since "$before" --restart-preview || die "Git pull completed; see the development runtime diagnostics above" ;;
  *) sed -n 2,7p "$0"; exit 2 ;;
esac
