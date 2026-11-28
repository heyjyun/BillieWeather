# Dual-Mac development and stable releases

Mac mini = development, tests, builds, overnight agents. MacBook Air = the stable app and real books.

| Document | For |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | roles, branches, isolation, **the stable-server decision** |
| [DEVELOPMENT_QUICKSTART.md](DEVELOPMENT_QUICKSTART.md) | **exact commands** to clone `main`, set up and run on an isolated database |
| [MAC_MINI_SETUP.md](MAC_MINI_SETUP.md) | setting up the mini from scratch |
| [MACBOOK_STABLE.md](MACBOOK_STABLE.md) | installing, upgrading and rolling back the stable app |
| [RELEASE_WORKFLOW.md](RELEASE_WORKFLOW.md) | development → tests → release build → DMG → install |
| [DATABASE_ISOLATION.md](DATABASE_ISOLATION.md) | every database and why development cannot reach the real one |
| [GIT_SYNC.md](GIT_SYNC.md) | branch state, first publication, daily sync rules |
| [REMOTE_DEVELOPMENT.md](REMOTE_DEVELOPMENT.md) | Tailscale, Screen Sharing, staying awake, unattended agents |

| Script (`ops/`) | Runs on | Does |
| --- | --- | --- |
| `bootstrap-mac-mini.sh [--check]` | mini | tools, clone, dependencies, isolated databases |
| `dev-services.sh start\|stop\|status\|reset` | mini | private PostgreSQL + Rails :38530 + identity-api :38531 |
| `dev-services.sh preview start\|stop\|restart\|status\|check` | both | browser preview (Vite :1420); reports and restarts a stale one after a pull |
| `doctor.sh [--tests] [--build]` | mini | independence/isolation checks, all suites, Dev app build |
| `release-build.sh` | mini | tagged, tested, reproducible release folder with DMG and checksums |
| `install-stable.sh` | MacBook | verify → back up → install; `--check`, `--status`, `--rollback` |
| `git-sync.sh status\|check\|push\|pull` | both | scanned, non-force sync through GitHub |
| `agent-run.sh` + `install-recovery-agent.sh` | mini | checkpointed Claude Code tasks in tmux, launchd recovery |
