# Dual-Mac architecture

Two computers with separate jobs. Git (GitHub) and release folders are the only things that move
between them. No database, `.env`, Keychain item or service is shared.

| | Mac mini — development | MacBook Air — daily use |
| --- | --- | --- |
| Purpose | engineering, tests, native GUI QA, builds, DMG packaging, overnight agents | the stable BillieWeather app and the person's own books |
| Source | full checkout, `autonomous-development` + feature branches | none needed (optional read-only clone) |
| Toolchain | Ruby 4.0.3, Node 24, Rust ≥1.94, uv/Python, PostgreSQL 14, CLT | none (macOS built-ins only) |
| Databases | isolated PostgreSQL cluster (`bin/billie-local`, socket only) + QA SQLite under `com.billieweather.client.qa.*` | the app's SQLite under `com.billieweather.client` |
| Apps | QA builds only (`com.billieweather.client.qa.<suffix>`), dev builds (`…client.dev`) | `/Applications/BillieWeather.app` (`com.billieweather.client`) |
| Servers | Rails :38530, identity-api :38531 on 127.0.0.1 (`ops/dev-services.sh`) | whatever the stable build was given (see "Stable servers") |
| Agents | Claude Code / Codex via `ops/agent-run.sh`, tmux, launchd recovery | none |

```
           feature branch ──► autonomous-development ──► main ──► tag vX.Y.Z
 Mac mini:   ops/doctor.sh --tests      native QA (QA bundle)     ops/release-build.sh
                                                                      │  ~/BillieWeather-Releases/X.Y.Z/
                                                                      ▼  (DMG, manifest, compat, SHA256SUMS)
 MacBook:                                          ops/install-stable.sh  (verify → back up → install)
                                                   ops/install-stable.sh --rollback
```

## Branches and tags

- `main` — verified stable source. Only fast-forwarded from `autonomous-development` after native QA.
- `autonomous-development` — former integration branch; fully merged into `main` on 2026-11-25. New work branches from `main`.
- `feature/*`, `fix/*`, `infra/*` — one task each, usually in its own worktree.
- `rollback/*` — kept fallbacks (e.g. `rollback/session-safe`).
- `vX.Y.Z[-pre]` annotated tags — a release; `ops/release-build.sh` only builds at a tag.
- `checkpoint/*` tags — local safety points before risky work; not pushed unless asked.

Details: [GIT_SYNC.md](GIT_SYNC.md).

## Isolation guarantees (summary)

1. **Bundle identifier separates data.** The shipped app owns `~/Library/Application Support/com.billieweather.client` and its Keychain service; every QA build has `…client.qa.<suffix>` and `qa.mjs preflight` refuses anything else. A debug build refuses to run as the shipped identifier (`src-tauri/src/variant.rs`).
2. **The development Mac has no real data.** `ops/doctor.sh` fails if the shipped app's database exists there.
3. **Servers cannot reach production.** `bin/billie-local` builds `DATABASE_URL` itself, verifies database name, data directory, socket-only listening and role, and refuses to run beside `.env` files.
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
