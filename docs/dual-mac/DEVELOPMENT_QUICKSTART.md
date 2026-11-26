# Development quick start (any second Mac)

From a clean Apple Silicon Mac to a running BillieWeather stack on an isolated local database.
Nothing here connects to Neon, Render or another Mac. The repository is **public**: never commit
`.env*` files, databases, statements, receipts, screenshots of real books or logs with personal data.

## Once: tools and checkout

```sh
xcode-select --install                     # dialog; skip if already installed
# Homebrew: https://brew.sh (asks for the admin password)
brew install gh && gh auth login           # needed for pushing; cloning works without it
mkdir -p ~/Developer && cd ~/Developer
git clone https://github.com/heyjyun/BillieWeather.git BillieWeather && cd BillieWeather
ops/bootstrap-mac-mini.sh --check          # reports what is missing, changes nothing
ops/bootstrap-mac-mini.sh                  # tools (incl. postgresql@18), Ruby 4.0.3, Node 24, gems,
                                           # JS, identity-api .venv, Rust crates, isolated cluster
mkdir -p ~/.billieweather-dev && cp ops/env/mac-mini.env.example ~/.billieweather-dev/env
echo 'source ~/.billieweather-dev/env' >> ~/.zshrc && source ~/.billieweather-dev/env
```

Do **not** copy `.env`, `.env.local`, `services/identity-api/.env`, any `billieweather.db` or Keychain
items from the other Mac. For the shared Neon development branch, generate them on this Mac with
`neon auth && ops/neon-dev-env.sh` ([details](DATABASE_ISOLATION.md#shared-neon-development-branch-since-2026-11-26)).
`config/database.yml` refuses the production endpoint in development and test, accepts a remote development
database only when it is the pinned `development` branch, and otherwise requires a local `*_development` /
`*_test` database. `bin/billie-local` refuses to run while a `.env*` file is in the checkout.

## Every day

```sh
cd ~/Developer/BillieWeather
git switch main && git pull --ff-only
bundle install && yarn install --immutable                  # only when Gemfile.lock / yarn.lock changed
(cd clients/universal && npm ci) ; (cd services/identity-api && uv sync --frozen)
yarn build && yarn build:css                                # web JS/CSS into app/assets/builds (ignored by Git)

ops/dev-services.sh start     # private PostgreSQL 18 (socket only) + Rails 127.0.0.1:38530
                              # + identity-api 127.0.0.1:38531; recreates the cluster after a reboot
ops/dev-services.sh status
open http://127.0.0.1:38530   # web app (synthetic data only)
```

Mac app (development build, own identifier `com.billieweather.client.dev`, own data folder):

```sh
cd clients/universal
VITE_BILLIE_API_URL=http://127.0.0.1:38530 VITE_BILLIE_IDENTITY_URL=http://127.0.0.1:38531 npm run desktop:dev
```

Vite uses port 1420 (strict); Rails and identity-api only accept the app from `localhost:1420` (and the
1430 diag build) in development, so stop any other project that holds 1420.

Stop or start clean:

```sh
ops/dev-services.sh stop
ops/dev-services.sh reset     # deletes only the /tmp/billie-roadmap.* cluster, then starts a fresh one
```

## Tests

```sh
export BILLIE_LOCAL_ROOT="$(cat ~/.billieweather-dev/local-root)"
bin/billie-local test                                   # Rails suite on billie_isolated_test
bin/billie-local test test/lib/billie_database_target_test.rb
(cd clients/universal && npx tsc --noEmit && npx vitest run)
(cd services/identity-api && IDENTITY_TEST_DATABASE_URL=postgresql://localhost/billieweather_identity_compat uv run pytest)
ops/doctor.sh --tests          # isolation checks plus all suites
```

The identity-api suite needs a local PostgreSQL on `localhost` (it creates its own `*_compat` database).
If none runs there, start a throwaway one: `initdb -D /tmp/bw-pg -U postgres -A trust &&
pg_ctl -D /tmp/bw-pg -o "-p 55432 -c listen_addresses=127.0.0.1" start`, then use
`postgresql://postgres@127.0.0.1:55432/billieweather_identity_compat`.

## What runs where

| Thing | This Mac | Never |
| --- | --- | --- |
| Rails, identity-api | `bin/dev` + identity-api on the Neon branch `development` (`ops/neon-dev-env.sh`), or `bin/billie-local` → `billie_isolated_development` | the production Neon branch (refused) |
| Schema changes | `bin/billie-dev-db db:migrate` (Neon development branch), `bin/billie-local rails db:migrate` and `bin/billie-local identity -m identity_api.schema migrate` | `db:*` tasks in production (blocked); production uses `bin/billie-release` (runbook) |
| Mac app data | `~/Library/Application Support/com.billieweather.client.dev/` | `com.billieweather.client` (the stable app's real book) |
| Pushing `main` | allowed; does not deploy (Render Auto-Deploy is Off since 2026-11-26) | `push --force` |

See [DATABASE_ISOLATION.md](DATABASE_ISOLATION.md) and, for production, the
[Render and Neon runbook](../audits/render-neon-release-runbook.md).
