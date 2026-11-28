# Mac mini setup (development machine)

Short version for any second Mac: [DEVELOPMENT_QUICKSTART.md](DEVELOPMENT_QUICKSTART.md).

Time: about an hour, most of it downloads. Steps marked 👤 need a person at the Mac or an approval.

## 1. macOS

1. 👤 Sign in with a **separate macOS user** for development if the mini is shared (recommended:
   a standard account named e.g. `dev`). Keep FileVault on.
2. 👤 System Settings → General → Sharing: turn on **Remote Login** (SSH) and **Screen Sharing**, allowed
   for that user only.
3. 👤 Tailscale: install, sign in with your account, and confirm the mini appears in the tailnet
   (`tailscale status`). Optionally enable Tailscale SSH.
4. Energy: System Settings → Energy → "Prevent automatic sleeping when the display is off" **on**,
   "Wake for network access" **on**. Leave the screen lock as it is (see REMOTE_DEVELOPMENT.md).
5. 👤 `xcode-select --install` (a dialog appears).

## 2. Bootstrap

```sh
# The repository is PUBLIC: clone needs no sign-in; gh is for pushing. Never commit .env files or real data.
brew install gh && gh auth login            # browser sign-in
mkdir -p ~/Developer && cd ~/Developer
gh repo clone heyjyun/BillieWeather BillieWeather && cd BillieWeather
git switch main                             # the only long-lived branch; temporary branches start here
ops/bootstrap-mac-mini.sh --check           # what is missing
ops/bootstrap-mac-mini.sh                   # install tools, dependencies, isolated databases
echo devbox > ~/.billieweather-dev/role     # marks this Mac as the development machine
cp ops/env/mac-mini.env.example ~/.billieweather-dev/env && echo 'source ~/.billieweather-dev/env' >> ~/.zshrc
```

The bootstrap installs: Homebrew packages (`git gh mise uv rust postgresql@18 vips redis overmind
graphviz sqlite tmux jq`; PostgreSQL 18 = CI and production), Ruby 4.0.3 and Node 24 through mise, gems (`vendor/bundle`), root JS (yarn 4
via corepack), `clients/universal` (npm ci), identity-api (`uv sync --frozen`), Rust crates, and an
isolated PostgreSQL cluster with development and test schemas and the identity schema loaded. OCR uses `tesseract.js` from npm:
nothing extra.

It does **not** copy anything from the MacBook: no databases, `.env` files, Keychain items, statements,
receipts or `ClaudeGenerated/` artifacts. Test fixtures come from the repository.

## 2b. Shared Neon development database (same one as the MacBook)

Both Macs run `bin/dev` (:3000) and identity-api (:8100) against the Neon branch `development`.
The mini gets its own copy of the credential from Neon; nothing is copied from the MacBook.

```sh
npm i -g neonctl && neon auth       # 👤 browser sign-in (same Neon account as the MacBook)
ops/neon-dev-env.sh                 # verifies the independent Development project in Neon, writes .env.local + services/identity-api/.env (600)
bin/billie-dev-db                   # expect: no "down" migrations; otherwise bin/billie-dev-db db:migrate
```

Schema changes made on one Mac are visible to the other at once. Run `bin/billie-dev-db db:migrate` only
after `ops/git-sync.sh pull`, so both Macs have the migration files. Do not run `db:rollback`, `db:reset` or
`db:schema:load` against the shared branch (`bin/billie-dev-db` refuses them). See
[DATABASE_ISOLATION.md](DATABASE_ISOLATION.md#independent-neon-projects).

### Installed Dev app (both Macs)

```sh
ops/install-dev.sh            # builds and installs /Applications/BillieWeather Dev.app (com.billieweather.client.dev)
ops/install-dev.sh --status   # both apps, and each one's data folder, WebView storage and keychain entry
```

The Dev app talks only to `localhost:3000` / `localhost:8100` (independent Neon Development project); the build refuses a
hosted server. It never replaces or opens `/Applications/BillieWeather.app` (Stable) or its data. Sign in
only with synthetic accounts (`~/.billieweather-dev/`).

### One-command sync after setup

Run `ops/sync-dev-mac.sh` from your clean `main` checkout. It fast-forwards from GitHub, installs
the pinned dependencies, validates the independent Development database, and rebuilds the Dev app.
Each Mac retrieves its own Development credentials through its authorized Neon CLI session.

## 3. Verify independence

```sh
ops/dev-services.sh start          # Rails :38530, identity-api :38531, private cluster
ops/doctor.sh --tests --build      # tools, isolation, all suites, a Dev app build
```

All checks must pass with the MacBook switched off.

## 4. Native verification

There are no QA app bundles. Verify native behavior with `cd clients/universal/src-tauri && cargo test`,
the client with Vitest and the Vite client in a headless browser, and by hand in the Dev app
(`ops/install-dev.sh`). Never drive a native app's GUI while someone is using the Mac.

## 5. Agents

```sh
npm i -g @anthropic-ai/claude-code   # or the installer from claude.com; then 👤 `claude` once to sign in
brew install codex                   # optional; 👤 sign in once
ops/install-recovery-agent.sh        # launchd: resumes interrupted tasks every 30 min
ops/agent-run.sh start night-1 prompts/night-1.md
ops/agent-run.sh status
```

## 6. Git: one shared `main` with the MacBook

The mini and the MacBook both work on `main` through GitHub; there is no integration branch.

```sh
ops/git-sync.sh pull                        # start of every session: fast-forward main only
git switch -c feature/x                     # optional temporary branch for larger or agent work
# … commit, ops/doctor.sh --tests …
git fetch origin && git rev-list --left-right --count main...origin/main   # divergence check
ops/git-sync.sh push main                   # a person pushes; never --force
```

GitHub has only `main` since 2026-11-26. For a clone made before then, see
[GIT_SYNC.md → Syncing an older clone](GIT_SYNC.md#syncing-an-older-clone-mac-mini): it fetches with
`--prune`, checks every local branch for unique work, then fast-forwards `main`. Rules and the full
flow: [GIT_SYNC.md](GIT_SYNC.md).

Agents on the mini commit locally and never push. Pushing `main` does not deploy: Render Auto-Deploy
is Off and production deploys are started by hand. Confirm it is still Off before pushing `main`; see
[RELEASE_WORKFLOW.md](RELEASE_WORKFLOW.md#render-deployment-separate-from-git-sync).
No production credential (production Neon owner/runtime URL, `BILLIE_RELEASE_APPROVAL`) is ever stored on the
mini. The development branch credential is not a production credential: its password exists only on that branch.

## 7. Releases

`ops/release-build.sh` at a tag → `~/BillieWeather-Releases/<version>/`. See RELEASE_WORKFLOW.md.
