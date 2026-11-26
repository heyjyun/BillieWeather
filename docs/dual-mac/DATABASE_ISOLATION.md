# Database isolation

## Every database, and who may touch it

| Database | Where | Owner | Touched by development? |
| --- | --- | --- | --- |
| Stable app SQLite `billieweather.db` (+ `.pre-vN-*.bak` copies the app makes before each migration) | MacBook `~/Library/Application Support/com.billieweather.client/` | the person | **never** |
| Stable app session | MacBook Keychain, service `com.billieweather.client` | the person | never |
| Installer backups | MacBook `~/BillieWeather-Backups/<time>-<version>/` (app + whole data folder) | the person | never |
| Production PostgreSQL (Neon) | cloud | release operator | only by `bin/billie-release` with an approval reference |
| **Development PostgreSQL** | Neon project `odd-firefly-71205607`, branch `main`, endpoint `ep-old-surf-be0dnct5` | Development role | yes, synthetic accounts only |
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

## Independent Neon projects

| Setting | Development | Production |
| --- | --- | --- |
| Project | `odd-firefly-71205607` | `sparkling-sun-34139417` |
| Branch | `main` (`br-tiny-brook-besd7lsc`) | `production` (`br-damp-sea-bd1swyfw`) |
| Direct endpoint ID | `ep-old-surf-be0dnct5` | `ep-raspy-sound-bdlg3br7` |
| Database | `billieweather_development` | `neondb` |
| Development role | `billie_development_owner` | Role absent |
| Server-side marker | `development` and the pinned target ID | Awaiting G2 |
| Application path | Dev app → local Rails and identity services | Stable app → Render Rails |

`ops/neon-dev-env.sh` checks the Development project, its default branch and endpoint using the Neon API.
It uses TLS hostname verification and confirms the server-side marker before writing the two ignored
dotenv files with mode 600. Rails and identity verify the marker on new development connections.
Their database guards reject the Production endpoint in development and test. The QA runner uses a
private local PostgreSQL Unix socket and synthetic fixtures.

On each authorized Mac, use its existing Neon CLI session to run:

```sh
ops/neon-dev-env.sh
bin/billie-dev-db db:abort_if_pending_migrations
```

The first step also pins the ignored Neon CLI context to the Development project. Keep the credentials
on each Mac and run the local services on loopback. To rehearse QA use a separate source tree without
dotenv files and the socket-only `bin/billie-local` runner.

Rebuild Development from Rails migrations and the identity schema migrations if a fresh target is
needed. Use an independently provisioned project and a new role and marker. The old Development branch
inside the Production project is historical and has no role in the Dev setup.

## Leftover QA folders on the MacBook

These hold synthetic data only and can be deleted once Phase 6.3 is closed (the installed app never reads
them): `com.billieweather.client.qa.p58`, `…qa.p63`, `com.billieweather.phase1a.qa.*`,
`com.billieweather.roadmap.phase*`. Their Keychain items: `security find-generic-password -s <identifier>`.
