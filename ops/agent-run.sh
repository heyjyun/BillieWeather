#!/usr/bin/env bash
# Unattended Claude Code work on the development Mac, with checkpoints and safe recovery.
#   ops/agent-run.sh start <task> <prompt-file>   new task: fixed session id, runs in tmux
#   ops/agent-run.sh resume <task>                continue an interrupted task in the same session
#   ops/agent-run.sh recover                      resume every task marked interrupted (launchd calls this)
#   ops/agent-run.sh status | stop <task>
#
# State lives outside the repository in ~/.billieweather-dev/agents/<task>/:
#   session (uuid), prompt.md, state (running|interrupted|limited|done|failed), attempts, next_try, log
# The agent itself keeps docs/audits/<task>-checkpoint.md in the repo up to date (see the appended
# instruction below) so any later session, Claude or Codex, can pick up from it.
#
# Safety: refuses to run unless this Mac is marked as the development machine
# (~/.billieweather-dev/role contains "devbox"). Permission mode comes from BILLIE_AGENT_PERMISSION_MODE
# (default acceptEdits); this script never passes --dangerously-skip-permissions.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"; HOME_DIR="$HOME/.billieweather-dev"; AG="$HOME_DIR/agents"; mkdir -p "$AG"; chmod 700 "$HOME_DIR"
MAX_ATTEMPTS="${BILLIE_AGENT_MAX_ATTEMPTS:-12}"; LIMIT_WAIT="${BILLIE_AGENT_LIMIT_WAIT:-1800}"
MODE="${BILLIE_AGENT_PERMISSION_MODE:-acceptEdits}"
die() { printf 'agent-run: %s\n' "$*" >&2; exit 1; }
[[ "$(cat "$HOME_DIR/role" 2>/dev/null)" == devbox ]] || die "not the development Mac (echo devbox > ~/.billieweather-dev/role on the Mac mini only)"
command -v claude >/dev/null || die "claude CLI not found"

CHECKPOINT_RULE='Work in small verified steps. After each step, commit to the current development branch and update docs/audits/TASK-checkpoint.md with: goal, done, in progress, next step, how to verify, open questions. Never push, never touch production services, never open the shipped app (com.billieweather.client); use ops/dev-services.sh and QA builds only. If you are resumed, read that checkpoint file first and continue from "next step".'

run_once() {  # $1 task, $2 first|resume
  local t="$1" d="$AG/$1" sid out rc
  sid="$(cat "$d/session")"; echo running >"$d/state"; echo $(( $(cat "$d/attempts" 2>/dev/null || echo 0) + 1 )) >"$d/attempts"
  local rule="${CHECKPOINT_RULE//TASK/$t}"
  local args=(-p --output-format json --permission-mode "$MODE" --append-system-prompt "$rule" -n "billie-$t")
  if [[ "$2" == first ]]; then args+=(--session-id "$sid"); prompt="$(cat "$d/prompt.md")"
  else args+=(--resume "$sid"); prompt="You were interrupted. Read docs/audits/$t-checkpoint.md and git log, then continue from the next step."; fi
  set +e; out="$(caffeinate -i -s claude "${args[@]}" "$prompt" 2>&1)"; rc=$?; set -e
  printf '\n=== %s attempt %s rc=%s\n%s\n' "$(date '+%F %T')" "$(cat "$d/attempts")" "$rc" "$out" >>"$d/log"
  if echo "$out" | grep -qiE 'usage limit|rate limit|limit reached|overloaded|429|try again later'; then
    echo limited >"$d/state"; echo $(( $(date +%s) + LIMIT_WAIT )) >"$d/next_try"
  elif (( rc == 0 )) && echo "$out" | grep -q '"is_error":false'; then echo done >"$d/state"
  else echo interrupted >"$d/state"; echo $(( $(date +%s) + 300 )) >"$d/next_try"; fi
  echo "$t: $(cat "$d/state")"
}

in_tmux() {  # an existing tmux server would otherwise hand the job its own (stale) environment
  local t="$1" mode="$2" envs=(-e "HOME=$HOME" -e "PATH=$PATH")
  for v in $(compgen -e | grep -E '^(BILLIE_|ANTHROPIC_|CLAUDE_)'); do envs+=(-e "$v=${!v}"); done
  tmux new-session -d "${envs[@]}" -s "billie-$t" -c "$REPO" "$REPO/ops/agent-run.sh _run $t $mode" 2>/dev/null || die "tmux session billie-$t already exists"; echo "started in tmux session billie-$t (tmux attach -t billie-$t)"; }

case "${1:-status}" in
  start)
    t="${2:?task name}"; f="${3:?prompt file}"; [[ "$t" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || die "task: lowercase letters, digits, dots, dashes"
    d="$AG/$t"; [[ ! -e "$d" ]] || die "task $t exists (resume it, or pick another name)"
    mkdir -p "$d"; cp "$f" "$d/prompt.md"; uuidgen | tr 'A-Z' 'a-z' >"$d/session"; echo 0 >"$d/attempts"
    in_tmux "$t" first ;;
  resume) t="${2:?task}"; [[ -d "$AG/$t" ]] || die "no task $t"; in_tmux "$t" resume ;;
  _run) run_once "$2" "$3" ;;
  recover)  # called by launchd every 30 minutes; does nothing unless a task is due
    now=$(date +%s)
    for d in "$AG"/*/; do [[ -d "$d" ]] || continue; t="$(basename "$d")"; s="$(cat "$d/state" 2>/dev/null)"
      [[ "$s" == interrupted || "$s" == limited ]] || continue
      (( now >= $(cat "$d/next_try" 2>/dev/null || echo 0) )) || continue
      (( $(cat "$d/attempts") < MAX_ATTEMPTS )) || { echo failed >"$d/state"; continue; }
      tmux has-session -t "billie-$t" 2>/dev/null && continue
      [[ -z "$(cd "$REPO" && git status --porcelain --untracked-files=no)" ]] || { echo "$t: uncommitted changes in $REPO; left for a person" >>"$d/log"; continue; }
      in_tmux "$t" resume; done ;;
  status) for d in "$AG"/*/; do [[ -d "$d" ]] && printf '%-28s %-12s attempts %s\n' "$(basename "$d")" "$(cat "$d/state")" "$(cat "$d/attempts")"; done; true ;;
  stop) t="${2:?task}"; tmux kill-session -t "billie-$t" 2>/dev/null || true; echo interrupted >"$AG/$t/state"; echo 9999999999 >"$AG/$t/next_try"; echo "stopped $t (resume manually)" ;;
  *) sed -n 2,8p "$0"; exit 2 ;;
esac
