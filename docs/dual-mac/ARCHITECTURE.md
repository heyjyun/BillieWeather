# Dual-Mac architecture

Two computers, one shared Git branch. Source moves only through GitHub (`origin/main`); release
folders move separately. No database, `.env`, Keychain item or service is shared.

| | Mac mini — main development | MacBook Air — daily use + occasional development |
| --- | --- | --- |
| Purpose | engineering, full tests, native GUI QA, builds, DMG packaging, overnight agents | the stable BillieWeather app and the person's own books; small source changes |
| Source | clone of `main` + short-lived branches/worktrees | clone of `main` + short-lived branches/worktrees |
| Toolchain | Ruby 4.0.3, Node 24, Rust ≥1.94, uv/Python, PostgreSQL 18, CLT | whatever the change needs; the full suite runs on the mini |
| Databases | isolated PostgreSQL cluster (`bin/billie-local`, socket only) + QA SQLite under `com.billieweather.client.qa.*` | the app's SQLite under `com.billieweather.client`; development only through `bin/billie-local` |
| Apps | QA builds only (`com.billieweather.client.qa.<suffix>`), dev builds (`…client.dev`) | `/Applications/BillieWeather.app` (`com.billieweather.client`) |
| Servers | Rails :38530, identity-api :38531 on 127.0.0.1 (`ops/dev-services.sh`) | see "Stable servers" |
| Agents | Claude Code / Codex via `ops/agent-run.sh`, tmux, launchd recovery; commit locally, never push | interactive sessions only |

```
  Mac mini ─┐                                   ┌─ MacBook
  fetch,    │   feature/* (optional, reviewed)   │  fetch,
  ff-only   ├──────────► origin/main ◄───────────┤  ff-only
  push      │                │                   │  push
            │                ├──► tag vX.Y.Z ──► ops/release-build.sh (mini) ──► ~/BillieWeather-Releases/X.Y.Z/
            │                │                                                   └► MacBook: ops/install-stable.sh
            │                └ ─ ► Render web: manual deploys only (Auto-Deploy Off) — see RELEASE_WORKFLOW.md
```

Git synchronization and Render deployment are separate: a push to `main` does not deploy (Render
Auto-Deploy is Off; a person starts each production deploy). See
[RELEASE_WORKFLOW.md](RELEASE_WORKFLOW.md#render-deployment-separate-from-git-sync).

## Branches and tags

- `main` — the single long-lived shared branch and the source of releases. Both Macs fetch it,
  fast-forward to it, and push to it without force after checking for divergence.
- `feature/*`, `fix/*`, `infra/*`, `audit/*` — temporary, one task each, often in their own worktree.
  Reviewed, merged into `main`, then deleted once nothing unique remains.
- No other permanent branch. GitHub holds only `main`. The integration, audit, release and rollback
  branches of November 2026 were consolidated into `main` and deleted on 2026-11-26.
- Rollback targets are commits in `main`'s history, not branches: the session-safe rollback release
  `dbd85e7` is reachable from `main` through a content-free merge (see RELEASE_WORKFLOW.md).
- `vX.Y.Z[-pre]` annotated tags — a release; `ops/release-build.sh` only builds at a tag.
- `archive/<date>/*` tags — local-only markers of retired branch tips (not on GitHub). New archive tags
  are not created: anything worth keeping is merged into `main` before a branch is deleted.
- `checkpoint/*` tags — local safety points before risky work; not pushed unless asked.

Details and the current branch inventory: [GIT_SYNC.md](GIT_SYNC.md).

## Isolation guarantees (summary)

1. **Bundle identifier separates data.** The shipped app owns `~/Library/Application Support/com.billieweather.client` and its Keychain service; every QA build has `…client.qa.<suffix>` and `qa.mjs preflight` refuses anything else. A debug build refuses to run as the shipped identifier (`src-tauri/src/variant.rs`).
2. **The development Mac has no real data.** `ops/doctor.sh` fails if the shipped app's database exists there. On the MacBook, development never opens the shipped app's database.
3. **Servers cannot reach production.** `bin/billie-local` builds `DATABASE_URL` itself, verifies database name, data directory, socket-only listening and role, and refuses to run beside `.env` files. In production, `config/database.yml` and `billie:release:check` refuse any URL that is not the approved Neon target (see RELEASE_WORKFLOW.md).
4. **The GUI driver acts only on a QA app**, only while it is frontmost, never within 20 s of keyboard/mouse input, never while the screen is locked, and exits with "refuse production" if pointed at `com.billieweather.client`.

Details: [DATABASE_ISOLATION.md](DATABASE_ISOLATION.md).

## Stable servers — a decision for the owner

The installed 0.1.0 and the 0.9.0-beta.1 candidate both sign in through **`localhost:3000` and
`localhost:8100` on the MacBook**. Those are the development servers in `billieweather/`, and their
configuration points at the **production Neon database**. So today the "stable" app needs a
development toolchain running on the MacBook, and that toolchain writes to production.

The local ledger (transactions, statements) stays on the device; the servers hold accounts and
sessions (and web data if synced). The options:

| Option | MacBook needs a toolchain | Works when the mini is off | Cost / authorization |
| --- | --- | --- | --- |
| A. Hosted account servers (Render + Neon, already described in `render.yaml` and `docs/audits/render-neon-release-runbook.md`) | no | yes | paid hosting; needs your authorization |
| B. Mac mini serves the stable account servers over Tailscale (separate "stable" service, not the dev stack) | no | **no** — sign-in fails | free; MacBook depends on the mini |
| C. Keep localhost servers on the MacBook (today) | **yes** | yes | free; contradicts "no dev toolchain on the MacBook" |

`ops/release-build.sh` refuses localhost URLs unless `BILLIE_ALLOW_LOCAL_SERVERS=1` is set on purpose,
and always refuses the QA ports. Recommendation: **A** for independence. Until you decide, keep the
installed 0.1.0 and its servers untouched.
