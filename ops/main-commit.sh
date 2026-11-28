#!/usr/bin/env bash
# Coordinated commits on `main` for concurrent Claude Code / Codex / human sessions.
# BillieWeather develops on one branch (`main`); this replaces per-feature branches as the
# isolation mechanism. See docs/dual-mac/GIT_SYNC.md → "Main-only development".
#
#   ops/main-commit.sh claim   <owner> <path>...          claim files or directories you are editing
#   ops/main-commit.sh release <owner> [path...]          release some (or all) of your claims
#   ops/main-commit.sh claims                             list active claims
#   ops/main-commit.sh commit  <owner> -m <msg> <path>... serialized commit of exactly these paths
#   ops/main-commit.sh lock    <owner> -- <command...>    run any index-changing git command under the lock
#
# <owner> is a stable session label, e.g. "claude-190ddcd1" or "codex-accounts" or "owner".
# State lives in the shared git directory (one copy for every worktree), never in the tree:
#   $(git rev-parse --git-common-dir)/billie-coordination/{claims.tsv,git.lock.d/}
set -euo pipefail
cd "$(dirname "$0")/.."
die() { printf 'main-commit: %s\n' "$*" >&2; exit 1; }

COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
STATE="$COMMON/billie-coordination"; mkdir -p "$STATE"
CLAIMS="$STATE/claims.tsv"; touch "$CLAIMS"
LOCK="$STATE/git.lock.d"
LOCK_WAIT="${BILLIE_LOCK_WAIT:-180}"

acquire() {  # $1 owner — mkdir is atomic; a lock whose holder process is gone is reclaimed
  local waited=0 pid
  while ! mkdir "$LOCK" 2>/dev/null; do
    pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      echo "main-commit: reclaiming stale lock of $(cat "$LOCK/owner" 2>/dev/null) (pid $pid gone)" >&2
      rm -rf "$LOCK"; continue
    fi
    (( waited >= LOCK_WAIT )) && die "lock held by $(cat "$LOCK/owner" 2>/dev/null || echo '?') for over ${LOCK_WAIT}s"
    sleep 1; waited=$((waited + 1))
  done
  echo $$ >"$LOCK/pid"; echo "$1" >"$LOCK/owner"
  trap 'rm -rf "$LOCK"' EXIT
}

norm() { local p="${1#./}"; echo "${p%/}"; }
overlaps() { [[ "$1" == "$2" || "$1" == "$2"/* || "$2" == "$1"/* ]]; }
holder() {  # $1 path, $2 owner → prints a conflicting claim's owner, if any
  local p c o
  p="$(norm "$1")"
  while IFS=$'\t' read -r c o _; do
    [[ -n "$c" && "$o" != "$2" ]] && overlaps "$p" "$c" && { echo "$o ($c)"; return 0; }
  done <"$CLAIMS"
  return 0
}
holds() {  # $1 path, $2 owner → true if owner has a claim covering path
  local p c o
  p="$(norm "$1")"
  while IFS=$'\t' read -r c o _; do
    [[ "$o" == "$2" ]] && { [[ "$p" == "$c" || "$p" == "$c"/* ]]; } && return 0
  done <"$CLAIMS"
  return 1
}
on_main() {
  local b; b="$(git symbolic-ref --quiet --short HEAD || true)"
  [[ "$b" == main ]] || die "HEAD is ${b:-detached}, not main — BillieWeather commits go to main only"
  local g; g="$(git rev-parse --git-dir)"
  [[ -e "$g/MERGE_HEAD" || -d "$g/rebase-merge" || -d "$g/rebase-apply" || -e "$g/CHERRY_PICK_HEAD" ]] &&
    die "a merge, rebase or cherry-pick is in progress; finish it first"
  return 0
}

cmd="${1:-}"; shift || true
case "$cmd" in
  claims) [[ -s "$CLAIMS" ]] && column -t -s $'\t' "$CLAIMS" || echo "no active claims" ;;
  claim)
    owner="${1:?owner}"; shift; (( $# )) || die "name at least one path"
    acquire "$owner"
    for p in "$@"; do
      h="$(holder "$p" "$owner")"; [[ -z "$h" ]] || die "$p is claimed by $h — coordinate first"
    done
    for p in "$@"; do holds "$p" "$owner" || printf '%s\t%s\t%s\n' "$(norm "$p")" "$owner" "$(date '+%F %T')" >>"$CLAIMS"; done
    echo "claimed by $owner: $*" ;;
  release)
    owner="${1:?owner}"; shift
    acquire "$owner"
    tmp="$CLAIMS.tmp.$$"
    if (( $# )); then
      keep="$(printf '%s\n' "$@" | while read -r p; do norm "$p"; done)"
      KEEP="$keep" awk -F'\t' -v o="$owner" 'BEGIN{n=split(ENVIRON["KEEP"],a,"\n");for(i=1;i<=n;i++)r[a[i]]=1} !($2==o && ($1 in r))' "$CLAIMS" >"$tmp"
    else
      awk -F'\t' -v o="$owner" '$2!=o' "$CLAIMS" >"$tmp"
    fi
    mv "$tmp" "$CLAIMS"; echo "released for $owner" ;;
  commit)
    owner="${1:?owner}"; shift
    [[ "${1:-}" == -m && -n "${2:-}" ]] || die "usage: commit <owner> -m <message> <path>..."
    msg="$2"; shift 2; (( $# )) || die "name the exact paths to commit; whole-tree commits are refused"
    acquire "$owner"; on_main
    for p in "$@"; do
      h="$(holder "$p" "$owner")"; [[ -z "$h" ]] || die "$p is claimed by $h — not committing another session's work"
      case "$(norm "$p")" in
        db/migrate/*|db/schema.rb)
          holds db/schema.rb "$owner" || die "Rails migrations need a claim on db/schema.rb first (ops/main-commit.sh claim $owner db/schema.rb)" ;;
        clients/universal/src-tauri/migrations/*)
          holds clients/universal/src-tauri/migrations "$owner" ||
            die "SQLite migrations need a claim on clients/universal/src-tauri/migrations first" ;;
      esac
    done
    git add -A -- "$@"
    git diff --cached --quiet -- "$@" && die "nothing to commit in: $*"
    # --only: commit just these paths; anything another session staged stays staged and uncommitted.
    git commit --only -m "$msg" -- "$@"
    git log -1 --format='committed %h on main: %s' ;;
  lock)
    owner="${1:?owner}"; shift; [[ "${1:-}" == -- ]] && shift; (( $# )) || die "usage: lock <owner> -- <command...>"
    acquire "$owner"; "$@" ;;
  *) sed -n 2,13p "$0"; exit 2 ;;
esac
