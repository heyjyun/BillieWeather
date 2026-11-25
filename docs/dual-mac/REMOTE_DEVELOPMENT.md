# Remote development and unattended work (Mac mini)

## Access

| Need | How |
| --- | --- |
| Shell | `ssh dev@<mini>.<tailnet>.ts.net` (Tailscale; Remote Login on), then `tmux attach` |
| Desktop / GUI tests | macOS Screen Sharing to the Tailscale name (`vnc://<mini>.<tailnet>.ts.net`) |
| Files | `scp`/`rsync` over Tailscale; release folders: `rsync -a mini:BillieWeather-Releases/<v>/ ~/BillieWeather-Releases/<v>/` |

No port is opened to the internet; everything goes through the tailnet.

## GUI tests without disturbing anyone

- They run only on the Mac mini, against QA bundles, in its own login session. The MacBook is never driven.
- The driver pauses (exit codes 4/5/6) when the screen is locked, the QA app is not frontmost, or there was
  keyboard/mouse input in the last 20 s (60 s before it brings a window forward). A Screen Sharing viewer
  that only watches does not count as input; moving the mouse in the viewer does.
- Runners wait for an idle window and resume; see `ops/agent-run.sh` and the Phase 6.3 runner pattern.

## Staying awake without weakening security

- Keep FileVault, the login password and the screen lock as they are. Do not enable automatic login.
- Per job, not permanently: `caffeinate -i -s` (no system sleep) is used by `ops/agent-run.sh` for exactly
  the job's lifetime. For a GUI acceptance window add `-d` (display on), e.g.
  `caffeinate -di -t 7200 <runner>`; when it ends, normal sleep and locking return.
- After a reboot the mini waits at the FileVault/login screen; a person (or Screen Sharing on the
  login window) must sign in. GUI tests cannot run before that, by design.
- Energy setting "prevent automatic sleeping when the display is off" keeps SSH/agents reachable while the
  display sleeps and the screen is locked; non-GUI work (tests, builds, agents) runs fine locked.

## Unattended Claude Code / Codex

```sh
echo devbox > ~/.billieweather-dev/role          # once; agent-run refuses on any other Mac
ops/install-recovery-agent.sh                    # launchd, every 30 min: ops/agent-run.sh recover
ops/agent-run.sh start p7-sync prompts/p7.md     # tmux session billie-p7-sync
ops/agent-run.sh status
tmux attach -t billie-p7-sync
ops/agent-run.sh stop p7-sync
```

- Each task has a fixed Claude session id, so recovery resumes the **same** conversation
  (`claude -p --resume <id>`).
- The agent keeps `docs/audits/<task>-checkpoint.md` (goal, done, next step, how to verify) and commits
  after each step, so a different tool (Codex, or a person) can continue from Git alone.
- A usage/rate limit marks the task `limited` and retries after `BILLIE_AGENT_LIMIT_WAIT` (default 30 min);
  other interruptions retry after 5 min; after `BILLIE_AGENT_MAX_ATTEMPTS` (12) it stops as `failed`.
- Recovery skips a task if the checkout has uncommitted changes (a person may be working) or its tmux
  session is still alive.
- Permission mode defaults to `acceptEdits`; the script never passes `--dangerously-skip-permissions`.
  Agents are instructed never to push, never to touch production, and never to open the shipped app.
- Codex: `codex exec` in a tmux session with `-s workspace-write`, and `codex resume --last` to continue;
  it reads the same checkpoint file.
