# Database isolation

## Every database, and who may touch it

| Database | Where | Owner | Touched by development? |
| --- | --- | --- | --- |
| Stable app SQLite `billieweather.db` (+ `.pre-vN-*.bak` copies the app makes before each migration) | MacBook `~/Library/Application Support/com.billieweather.client/` | the person | **never** |
| Stable app session | MacBook Keychain, service `com.billieweather.client` | the person | never |
| Installer backups | MacBook `~/BillieWeather-Backups/<time>-<version>/` (app + whole data folder) | the person | never |
| Production PostgreSQL (Neon) | cloud | release operator | only by `bin/billie-release` with an approval reference |
| **Shared development PostgreSQL (Neon branch `development`)** | cloud, project `sparkling-sun-34139417`, branch `br-tiny-cherry-bdqrn2ge`, endpoint `ep-cold-brook-bdbbvbj4` | developers on both Macs | yes — synthetic only; `bin/dev` (`:3000`) and identity-api (`:8100`) |
| Isolated dev/test PostgreSQL | Mac mini `/tmp/billie-roadmap.*` (socket only, no TCP) | `ops/dev-services.sh` | yes — synthetic only |
| QA app SQLite | Mac mini `~/Library/Application Support/com.billieweather.client.qa.<suffix>/` | QA runs | yes — synthetic only |
| Dev app SQLite (`tauri dev`) | Mac mini `…/com.billieweather.client.dev/` | developer | yes — synthetic only |

## Why development cannot reach the MacBook's real database

1. It is on another computer. Nothing on the Mac mini mounts, syncs or opens MacBook files; there is no
   shared folder, iCloud Drive sync of `Application Support`, or network database.
2. On the Mac mini, the shipped identifier is never run: `qa.mjs preflight` rejects it, debug builds refuse
   it, and `ops/doctor.sh` fails if `com.billieweather.client/billieweather.db` appears.
3. Release builds are installed on the MacBook only by `ops/install-stable.sh`, which closes nothing by
   force, refuses a running app, refuses a DMG with any other identifier, refuses a downgrade (database
   newer than the release), checks integrity, and copies the app **and** the whole data folder first.
4. The installer never writes the database. The app migrates it on first launch, after making its own
   copy (`billieweather.db.pre-v<N>-<time>.bak`).

## Why QA databases stay isolated

- One bundle identifier per QA run (`qa.p63`, `qa.night2`, …) → its own data folder and Keychain item.
- `bin/billie-local` creates a fresh cluster under `/tmp/billie-roadmap.<random>`, owned by the user,
  `listen_addresses = ''` (no TCP), and verifies `current_database`, `data_directory`, socket-only and
  role before Rails or identity-api start. It refuses to run beside `.env` files.
- QA servers use 127.0.0.1:38530/38531; `qa.mjs` refuses development ports (3000/8100), and
  `ops/release-build.sh` refuses the QA ports, so a QA server can never be baked into a release.
- Fixtures are synthetic: `packages/*/fixtures`, `ClaudeGenerated/rc-fixtures`, seeded `ZXQ …` /
  `QA SYNTHETIC …` rows, `@example.com` accounts.

## Shared Neon development branch (since 2026-11-26)

Until 2026-11-26, `.env.local` and `services/identity-api/.env` on the MacBook pointed the `:3000`/`:8100`
development servers at the **production** Neon endpoint. They now point at a dedicated branch:

| | Development | Production (unchanged) |
| --- | --- | --- |
| Neon branch | `development` — `br-tiny-cherry-bdqrn2ge`, created schema-only (`init_source: parent-schema`, no parent data) | `production` — `br-damp-sea-bd1swyfw` (default branch) |
| Endpoint | `ep-cold-brook-bdbbvbj4` (direct) / `ep-cold-brook-bdbbvbj4-pooler` (pooled) | `ep-raspy-sound-bdlg3br7` |
| Data | synthetic only (`@example.com` test accounts) | real accounts |
| `neondb_owner` password | the branch's own (reset after branching), so the development credential does not open production | unchanged |
| Server-side marker | `billie_release.target` = `development` + a non-secret target id | none yet (see the runbook) |
| Rails migrations | `bin/billie-dev-db db:migrate` (direct endpoint) | `bin/billie-release rails` only |

How development is kept off production (fail closed, Rails and identity-api alike):

1. `lib/billie_database_target.rb` / `identity_api/database_target.py` refuse the production endpoint
   (direct or `-pooler`) in development **and** test, whatever else is set. `BILLIE_PRODUCTION_DB_ENDPOINTS`
   can add more endpoint ids.
2. A remote development database is accepted only with `BILLIE_DB_ENV=development`, `BILLIE_DB_HOST` = the
   direct development endpoint, the URL host equal to it or its `-pooler` form, `sslmode=verify-full`,
   `BILLIE_DB_NAME` and `BILLIE_DB_TARGET_ID`. Anything else stops the server before it connects.
3. Every new connection must read `billie_release.target` and find `development` with the configured
   target id (`config/initializers/billie_development_database.rb`; the identity-api pool `configure`
   hook). Production has no such row, so a misrouted connection is closed before any query.
4. Tests never use Neon: `local!("test")` accepts only a local `*_test` database, and dotenv does not load
   `.env.local` in the test environment.
5. The credential lives only in the two git-ignored files (mode 600). `ops/neon-dev-env.sh --check` (run by
   `ops/doctor.sh`) fails if they name the production endpoint, lack the development pins, or are tracked.

The previous production-pointing files were moved to `~/BillieWeather-Backups/<time>-env-pre-neon-devbranch/`
(mode 600) on the MacBook. They contain the production owner password: delete them once production has its
own runtime role, or rotate that password in Neon.

### Set up (or repair) a Mac — no secret is copied

```sh
npm i -g neonctl && neon auth       # 👤 browser sign-in to the Neon account that owns the project
ops/neon-dev-env.sh                 # verifies branch id/name/endpoint from Neon metadata and the server-side
                                    # marker, then writes .env.local + services/identity-api/.env (mode 600)
bin/billie-dev-db                   # migration status on the development branch (direct endpoint)
bin/billie-dev-db db:migrate        # only if something is pending
bin/dev                             # Rails :3000; identity: (cd services/identity-api && uv run uvicorn identity_api.main:app --port 8100)
```

Never send the files, the URL or the password through GitHub, chat, mail or AirDrop. If a credential leaks,
reset the branch role (`neon roles reset-password neondb_owner --branch development`) and rerun
`ops/neon-dev-env.sh` on each Mac.

`bin/billie-local` (socket-only cluster) still works for fully offline work; it refuses to run while these
dotenv files exist, so use a separate worktree for it.

### Recovery options for the development branch

It holds only synthetic data, so the simplest recovery is to recreate it: a new schema-only branch from
`production`, the migration history copied from a production copy (not from production itself), a new
marker, `neon roles reset-password`, then `ops/neon-dev-env.sh` on both Macs (update `BRANCH_ID`/`DEV_ENDPOINT`
in that script). Neon's 6-hour history (free plan) also allows `neon branches restore development ^self@<time>`.
Never use `reset`/`restore` against `production` for development work.

## Leftover QA folders on the MacBook

These hold synthetic data only and can be deleted once Phase 6.3 is closed (the installed app never reads
them): `com.billieweather.client.qa.p58`, `…qa.p63`, `com.billieweather.phase1a.qa.*`,
`com.billieweather.roadmap.phase*`. Their Keychain items: `security find-generic-password -s <identifier>`.
