# Mac mini setup (development machine)

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
# 👤 GitHub access first (the repository is private)
brew install gh && gh auth login            # browser sign-in
mkdir -p ~/Developer && cd ~/Developer
gh repo clone heyjyun/BillieWeather BillieWeather && cd BillieWeather
git switch autonomous-development           # after it has been pushed from the MacBook (GIT_SYNC.md)
ops/bootstrap-mac-mini.sh --check           # what is missing
ops/bootstrap-mac-mini.sh                   # install tools, dependencies, isolated databases
echo devbox > ~/.billieweather-dev/role     # marks this Mac as the development machine
cp ops/env/mac-mini.env.example ~/.billieweather-dev/env && echo 'source ~/.billieweather-dev/env' >> ~/.zshrc
```

The bootstrap installs: Homebrew packages (`git gh mise uv rust postgresql@14 vips redis overmind
graphviz sqlite tmux jq`), Ruby 4.0.3 and Node 24 through mise, gems (`vendor/bundle`), root JS (yarn 4
via corepack), `clients/universal` (npm ci), identity-api (`uv sync --frozen`), Rust crates, and an
isolated PostgreSQL cluster with development and test schemas loaded. OCR uses `tesseract.js` from npm:
nothing extra.

It does **not** copy anything from the MacBook: no databases, `.env` files, Keychain items, statements,
receipts or `ClaudeGenerated/` artifacts. Test fixtures come from the repository.

## 3. Verify independence

```sh
ops/dev-services.sh start          # Rails :38530, identity-api :38531, private cluster
ops/doctor.sh --tests --build      # tools, isolation, all suites, a QA app build
```

All checks must pass with the MacBook switched off.

## 4. Native GUI acceptance

1. 👤 System Settings → Privacy & Security → **Accessibility** and **Screen Recording**: allow the app
   that runs the tests (Terminal/iTerm, Claude Code, or Codex). macOS asks the first time.
2. Build and launch only QA bundles: `cd clients/universal && node scripts/qa.mjs build <suffix>` then
   `node scripts/qa.mjs launch <QA.app>`.
3. GUI tests need an unlocked, idle session. They pause on keyboard/mouse input, a locked screen, or when
   the QA app is not in front. See REMOTE_DEVELOPMENT.md for running them over Screen Sharing.

## 5. Agents

```sh
npm i -g @anthropic-ai/claude-code   # or the installer from claude.com; then 👤 `claude` once to sign in
brew install codex                   # optional; 👤 sign in once
ops/install-recovery-agent.sh        # launchd: resumes interrupted tasks every 30 min
ops/agent-run.sh start night-1 prompts/night-1.md
ops/agent-run.sh status
```

## 6. Releases

`ops/release-build.sh` at a tag → `~/BillieWeather-Releases/<version>/`. See RELEASE_WORKFLOW.md.
