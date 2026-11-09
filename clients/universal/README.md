# BillieWeather Universal Client

One React + TypeScript codebase, packaged with **Tauri 2** for **macOS, Windows, iOS and Android**.
Financial data is stored **only on the device**, in SQLite. The Rails web app at the repository root
is not touched by anything in this folder.

```text
billieweather/
├── app/, config/, db/, Gemfile …   # Rails web app (unchanged, deployed to Render)
├── packages/
│   ├── shared-types/   # Transaction, Statement, Category … (types only)
│   ├── finance-core/   # import parsing, categorizer, rules, dashboard math — ported from Rails
│   │   └── fixtures/   # synthetic statements + Ruby-generated expected results
│   └── reporting/      # CSV export and a dependency-free .xlsx writer
└── clients/universal/
    ├── src/            # the one React app every platform runs
    │   ├── pages/      # Dashboard, Transactions, Import, Reports, Settings & privacy
    │   ├── components/ # shared UI pieces
    │   ├── hooks/      # useFinance (data context)
    │   └── services/   # store.ts (SQLite), platform.ts (the only platform-specific code)
    ├── src-tauri/      # Rust shell: plugins, permissions, migrations, icons
    └── test/           # storage, UI workflow, privacy guards
```

The shared packages are plain TypeScript with **no runtime dependencies**. They are resolved by
path alias, so there is no separate build step.

## Everyday development

Requirements: Node 24 and npm. Desktop builds also need Rust (`cargo`).

```sh
cd clients/universal
npm install          # isolated from the Rails app's yarn install
npm test             # 98 tests: Ruby parity, SQLite storage, full UI workflow, privacy guards
npm run typecheck
npm run dev          # browser preview at http://localhost:1420 (in-memory, nothing saved)
npm run desktop:dev  # the real app window with on-device SQLite
```

Use **npm** inside `clients/universal`. The repository root uses yarn for Rails assets; the two
installs never mix.

## Building each platform

| Platform | Command | Needs | Status on the dev Mac (2026-11-08) |
|---|---|---|---|
| macOS | `npm run desktop:build` → `.app` + `.dmg` in `src-tauri/target/release/bundle/` | Rust, Xcode Command Line Tools | **Built and launched** |
| Windows | `npx tauri build --bundles nsis,msi` on Windows | Rust (MSVC), WebView2 | Not built here (needs Windows); configured in CI |
| iOS | `npm run ios:init` once, then `npx tauri ios build --target aarch64-sim` | Full **Xcode**, `rustup target add aarch64-apple-ios-sim`, Apple team for devices | Not built: Xcode and rustup missing |
| Android | `npm run android:init` once, then `npx tauri android build --apk` | JDK 17, Android SDK + NDK, rustup Android targets | Not built: Java/SDK/NDK missing |

The Mac uses Homebrew's Rust, which cannot add cross-compile targets. Install Rust with
[rustup](https://rustup.rs) before trying the mobile builds.

### CI (GitHub Actions)

`.github/workflows/universal-client.yml` runs only when `clients/**` or `packages/**` change:

- **Every PR and push to main**: type check and all tests, then **unsigned** macOS and Windows
  builds uploaded as workflow artifacts.
- **Manual run with "mobile" ticked**: experimental Android debug APK and iOS simulator builds.
- **Nothing is published** to any app store, and the Rails/Render pipeline is untouched.

Signing (Apple Developer ID and notarization, Windows code signing, Play/App Store) is deliberately
not set up yet.

## Local-first privacy

- **Storage**: `sqlite:billieweather.db` in the app's private data directory, created by Tauri's SQL
  plugin. On macOS that is `~/Library/Application Support/com.billieweather.client/`; on iOS and
  Android it is the app sandbox.
- **No network**:
  - The WebView Content Security Policy allows only Tauri's local IPC bridge (`connect-src ipc: http://ipc.localhost`).
  - No HTTP plugin is installed.
  - `test/privacy.test.ts` fails the build if code adds `fetch`, `XMLHttpRequest`, `WebSocket`, logging calls, or cloud credentials.
- **Least privilege**: the app's permissions (`src-tauri/capabilities/default.json`) allow SQLite,
  the save dialog, and writing to the file the person picked. There is no file-system read scope;
  imports use the standard file picker.
- **No accounts, analytics, crash reporting, or sync.**
- **Deleting data** (Settings → Delete local data) removes every row and runs `VACUUM` to reclaim
  the freed pages.
- **Migrations**: `src-tauri/migrations/NNNN_*.sql`, applied in order by the SQL plugin. Never
  edit a shipped file; add a new numbered one that migrates data in place. Tests apply the same
  files.

### Encryption at rest — designed, **not implemented**

The database file is currently protected only by the operating system (FileVault, BitLocker, iOS
Data Protection, Android file-based encryption). The planned design:

1. Switch the SQL layer to **SQLCipher** (`rusqlite` with `bundled-sqlcipher`, behind a small
   custom Tauri command layer, because `tauri-plugin-sql` does not support SQLCipher keys).
2. Generate a random 256-bit key on first launch and keep it in the platform keystore:
   macOS/iOS Keychain, Windows Credential Manager (DPAPI), Android Keystore. Use the `keyring`
   crate on desktop and Tauri's mobile plugin API on iOS/Android.
3. Migrate an existing plaintext database with `sqlcipher_export`, verify it, then securely delete
   the old file.

Don't describe the app as encrypted until all three steps ship and are verified on each platform.

## Parity with Rails

The TypeScript logic is a port, not a rewrite, and it is checked against Rails:

```sh
# 1. Rails generates the expected results from the shared synthetic fixtures
RAILS_ENV=test bin/rails runner packages/finance-core/fixtures/generate_expected.rb
# 2. TypeScript must match them exactly
cd clients/universal && npm test
# 3. Rails' own import + dashboard must match the shared totals
bin/rails test test/services/finance/shared_fixture_parity_test.rb
```

Differences found while porting are encoded in the fixtures instead of being guessed:

- Ruby's `\b` is Unicode-aware, so "ÉCAFE" is not "cafe".
- `titleize` capitalizes a leading accented letter.
- Rails accepts extra values in the *first* data row, because Ruby's CSV library pads the header row.

When you change categorizer rules in Rails, regenerate the fixtures and update
`packages/finance-core/src/categorizer.ts`.

## Optional AI (Phase 5, not built yet)

The intended flow is local app → authenticated Rails API on Render → OpenAI. Requirements before
any code ships:

- No OpenAI key or database credential in the client. The app holds only a short-lived token from
  signing in to BillieWeather.
- A consent screen that shows exactly what will be sent. Send aggregated figures (monthly totals,
  category sums) rather than raw transactions, and only after a tap.
- On the Rails side: token auth, per-user rate limits and quotas, request size limits, and no
  logging of request bodies.
- Widen the CSP `connect-src` to that one Render origin only, and update `test/privacy.test.ts`
  to allow exactly that exception.
- Offline features keep working when the network or the API is unavailable.
