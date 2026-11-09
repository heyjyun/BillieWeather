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
npm test             # 120 tests: Ruby parity, SQLite storage, sign-in + full UI workflow, translations, privacy guards
npm run typecheck
npm run dev          # browser preview at http://localhost:1420 (in-memory, nothing saved)
npm run desktop:dev  # the real app window, signing in to http://localhost:3000
BILLIE_API_URL=https://your-billieweather.example npm run desktop:build   # point a build at production
```

The app needs the Rails server for sign-in. `scripts/tauri.mjs` bakes the server origin into the
build and its Content Security Policy. Use `https` for anything that isn't localhost.

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
- **Several databases**: a device can keep up to 8 local databases (the Data page creates them). Each
  is its own SQLite file: `billieweather.db`, `billieweather-2.db`, … `billieweather-8.db`, all with the
  same migrations (`src-tauri/src/lib.rs`; keep in step with `MAX_DATABASES` in `src/services/databases.ts`).
  The list and which one is in use are kept in `localStorage` (`billie.databases`, slot numbers only).
- **Database name**: every database has a name the person chose (the first one is named on first run,
  pre-filled with the device's own name: macOS Computer Name, Windows computer name, Android model,
  iOS "iPhone"/"iPad"). The name is only a label kept in that database's `settings` table. The cloud
  database has a name too (`users.cloud_database_name`, also editable on the website under Settings).
- **Network: account only**:
  - The app signs in to the BillieWeather Rails API (`/api/client/v1`, see `app/controllers/client_api/v1`). After that it only sends language, nickname and time-zone changes.
  - **Statements and transactions leave the device only when the person syncs a database to the cloud** (see *Managing data*). `src/services/account.ts` may not import any financial code (enforced by `test/privacy.test.ts`).
  - The WebView Content Security Policy allows exactly one origin besides the local IPC bridge: the BillieWeather server chosen at build time.
- **Accounts and preferences**:
  - Server side (existing Neon `users` columns, no migration): email, nickname, language, time zone, region, sign-up date and badges.
  - Device side:
    - The sign-in token is in the macOS/iOS Keychain or Windows Credential Manager (an app-only file on Android).
    - Account details are cached so the app opens offline after the first sign-in.
  - Changing the password on the website signs out every app.
- **Languages**:
  - English, 简体中文, 繁體中文, 日本語, 한국어 and Español, detected from the device and saved to the account.
  - Import error messages are copied from the Rails translations with `npm run sync:translations`.
- **Least privilege**: the app's permissions (`src-tauri/capabilities/default.json`) allow SQLite,
  the save dialog, and writing to the file the person picked. There is no file-system read scope;
  imports use the standard file picker.
- **No analytics, crash reporting, or financial sync.**
- **Managing data** (the Data page):
  - Lists the cloud and every local database side by side, each with its name, size (actual SQLite size locally, approximate in the cloud), its share of the total, contents, date range and last change, plus a bar of the shares. Databases on other devices are stored there and are not counted.
  - *Delete database* needs the typed confirmation word ("delete", localized) and says it cannot be undone. A local database is emptied and removed from the list (the last one is emptied and kept). The cloud database is deleted with `DELETE /api/client/v1/finance?confirm=delete`; website copies on devices become the devices' own data. Single statements can still be removed one at a time (`DELETE …/finance/statements/:id` in the cloud).
  - *Sync* copies what one database has into another (local → local, cloud → local, local → cloud). Only statements the target does not have (matched by file hash) are added; nothing is deleted from either side, so it is safe to repeat. The panel shows each side's statement/transaction counts and last change, and previews what will be added. Local → local goes straight between the two files; it uses the cloud only if "Also keep a copy in the cloud" is ticked.
  - **What leaves the device**: only when the person syncs *to the cloud* (or ticks the box), one statement per `POST …/finance/statements` request from `src/services/cloudUpload.ts` (the only code that sends statements; enforced by `test/privacy.test.ts`). Nothing is ever sent automatically.
- **Local database metadata on the website** (Settings → "Show My Local Databases on the Website", **off by default**, kept per account on this device):
  - When on, the app reports ONLY: a random database id, a random device id, the database name, the device name, size in bytes, statement/transaction/rule counts, first and last transaction date, last modified time and when the app session started. Never statement names, descriptions, amounts, balances, merchants, categories, accounts, paths or files. The request body is built from an explicit allowlist (`REPORT_FIELDS` in `src/services/localReport.ts`); the server rejects any other field; `test/privacy.test.ts` pins both.
  - One-way: `PUT /api/client/v1/devices/:device/databases/:database`, `DELETE` the same path (a database was deleted) and `DELETE /devices/:device` (switched off, forget everything). The server only displays it; no route can command a device.
  - Reported when the app opens and the person is signed in, and after creating, renaming or deleting a database, or finishing a sync. There is no timer and no background work. Unchanged data is not resent.
  - Offline, everything keeps working. Removals (deleted databases, "stop sharing") are queued in `localStorage` and retried with their original sequence number until the server confirms; the UI says "pending" until then. Per-device sequence numbers make retries and late, older reports harmless on the server (a deleted database stays deleted).
  - Database ids live in each database's `settings` table (`report_id`), stay the same across renames and disappear with the database.
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
