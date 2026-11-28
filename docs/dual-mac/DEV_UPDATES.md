# Automatic Development updates

Committed changes on `main` reach Development Web and **BillieWeather Dev.app** without anyone
asking for a rebuild. The owner authorized this on 2026-11-28 for routine Development builds,
Development service reloads, and additive Development migrations. Stable and Production are not
covered: they still need the owner's explicit approval for each release.

## How it works

Two triggers work together:

- **New commits:** the `.githooks/reference-transaction` hook starts a detached
  `ops/dev-update.sh run` whenever `refs/heads/main` moves through a commit, a `git-sync` pull, or a
  merge. The run uses the access of the session that moved `main`. It never blocks the Git command,
  and it runs at `nice 10`. Set `BILLIE_DEV_UPDATE_DISABLE=1` to suppress it for one Git command.
- **Upkeep:** the launchd job `com.billieweather.dev-update` runs `tick` every 5 minutes and at login,
  at background priority. It finishes a deferred Dev.app install and restarts the deployed
  Development services if they are down, for example after a reboot. It runs a copy of the script
  in `~/.billieweather-dev/dev-update/bin/` and never reads the repository, because macOS privacy
  protection (TCC) does not let launchd jobs read `~/Documents`.

A run with nothing new exits in about a second. Runs are serialized by a lock, so concurrent commits
or agents never start two builds. A commit that has already been deployed, or one that has already
failed, is not rebuilt. If several commits land during a build, the next trigger builds the newest
one.

Each run takes the exact commit of `refs/heads/main`, never the working tree. Uncommitted or
unfinished work from concurrent sessions is therefore never built, served, or installed. No branch,
worktree, or checkout is created. The run has six stages, and any failure stops it:

| Stage | What happens | On failure |
| --- | --- | --- |
| 1. snapshot | `git archive <sha>` into `~/.billieweather-dev/dev-update/runtime/<sha>/`. `.env.local` and `services/identity-api/.env` are copied in (mode 600). Dependencies are cached per lockfile and cloned copy-on-write. Web assets are built. | nothing else runs |
| 2. validate | Rails eager-load check (`zeitwerk:check`). The Universal typecheck and production bundle run as part of the Tauri build. | nothing else runs |
| 3. migrate | Verifies that `.env.local` pins `BILLIE_DB_ENV=development` and that the host is not a production endpoint (the database guard also requires the `development` marker). Pending migrations must be additive: anything that drops, removes, renames, or changes columns or tables, or that runs raw DELETE/UPDATE/DROP/TRUNCATE, stops the run for review. Then `bin/billie-dev-db db:migrate`. | Dev.app and services unchanged |
| 4. build | Builds Dev.app (`BILLIE_VARIANT=dev`, localhost servers only) with the commit's build number (`git rev-list --count`) as `CFBundleVersion` and the full commit SHA embedded as `sourceRevision`. The bundle checks from `ops/install-dev.sh` apply: identifier, localhost API, no hosted server, code signature. | the installed Dev.app stays |
| 5. services | Restarts Rails (:3000, tmux `billie-rails`) and identity (:8100, tmux `billie-id`) from the snapshot, then health-checks `/up` and `/health`. | the previous snapshot is restarted, and Dev.app is not installed |
| 6. install | Copies the bundle next to `/Applications/BillieWeather Dev.app`, verifies it, and swaps it in. The previous three Dev.app copies are kept in `~/.billieweather-dev/dev-update/previous-apps/`. If Dev is open, the build is staged and installed after you quit it. | the installed Dev.app stays |

The Dev app's data (SQLite, WebView storage, keychain entry under `com.billieweather.client.dev`)
lives outside the bundle, so updates keep it. Stable (`/Applications/BillieWeather.app`,
`com.billieweather.client`) and its data are never touched.

A failure shows a macOS notification. The reason is recorded in
`~/.billieweather-dev/dev-update/failed-reason`, and the full log for each run is in
`~/.billieweather-dev/dev-update/logs/`.

## Commands

```sh
ops/dev-update.sh status          # committed main, deployed commit, Dev.app build, services, last failure, Stable
ops/dev-update.sh run             # update now (no-op when current); `run --force` retries a failed commit
ops/dev-update.sh install-agent   # install or refresh the launchd job (once per Mac)
ops/dev-update.sh remove-agent
```

Recovery: to go back to the previous Dev.app, quit Dev, then move a copy from
`~/.billieweather-dev/dev-update/previous-apps/` to `/Applications/BillieWeather Dev.app`. The previous
Web snapshot stays in `runtime/` until the next successful update.

## What this means for sessions working on `main`

- `localhost:3000` and `localhost:8100` serve the **last committed and deployed** `main`, not the
  working tree. To try uncommitted work, use the Rails test database (`RAILS_ENV=test bin/rails server
  -p 3100`), the Vite preview, or a temporary local cluster. Never stop the managed :3000/:8100
  services.
- Commit when work is complete and validated. The update job picks it up within seconds.
- A migration that is not additive stops the automatic update. A person reviews it and runs
  `ops/dev-update.sh run --force` once it is safe for the Development database.
