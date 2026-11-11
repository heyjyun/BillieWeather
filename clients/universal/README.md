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
│   └── design-tokens/  # colors, type, spacing, icons: one source for the website and every app
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

Requirements: Node 24 and npm. Desktop builds also need Rust (`cargo`). macOS desktop builds additionally need the Xcode Command Line Tools
(`xcode-select --install`), which provide `swiftc` for the Apple Vision OCR library compiled by `src-tauri/build.rs`.
End users of the built app need nothing extra: it requires macOS 11+ and uses the system Swift runtime and Vision framework.
Web-only development (`npm run dev`, `npm test`) needs no Swift.

```sh
cd clients/universal
npm install          # isolated from the Rails app's yarn install
npm test             # 370 tests (real OCR engines included where available): Ruby parity, universal import, SQLite storage, sign-in + full UI workflow, translations, privacy guards
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
  - **Categorize with AI** (Categories page) is the one other exception, and only after the person confirms a consent panel that lists exactly what is sent: per merchant, the description cleaned on the device (`cleanForAi`: no digits, no email addresses), "in"/"out" and a short key, plus the names of their own categories. It goes from `src/services/aiCategorize.ts` to `POST /api/client/v1/finance/categorize` on the BillieWeather server, which holds the OpenAI key; the app never contacts OpenAI and holds no key. Amounts, dates, balances and statement names are never sent (the request body is pinned by `test/privacy.test.ts`).
  - The WebView Content Security Policy allows exactly one origin besides the local IPC bridge: the BillieWeather server chosen at build time.
- **Accounts and preferences**:
  - Server side (existing Neon `users` columns, no migration): email, nickname, language, time zone, region, sign-up date and badges.
  - Device side:
    - The sign-in token is in the macOS/iOS Keychain or Windows Credential Manager (an app-only file on Android).
    - Account details are cached so the app opens offline after the first sign-in.
  - Changing the password on the website signs out every app.
- **Languages**:
  - English, 简体中文, 繁體中文, 日本語, 한국어 and Español, detected from the device and saved to the account.
  - Import error messages, PDF review warnings and the PDF review page text are copied from the Rails translations with `npm run sync:translations`.
- **Universal import** (CSV, TSV, Excel `.xlsx`, OFX/QFX) is read on the device by `packages/finance-core/src/universal`
  (see its README) and always shown as a preview first: settings that change results (date order, decimal separator,
  currency, credit-card signs, unclear encodings, a bank template whose columns changed) must be chosen, rows that need a
  decision must be decided, and only then can the person import. Overlapping statements are detected per account;
  each import is written atomically (migration `0004`) and can be undone from Import history. Photos and scanned
  statements are read by an **on-device OCR engine** (see *On-device OCR* below).
- **PDF statements** are read on the device with pdf.js (`src/services/pdfText.ts`, loaded only when a PDF is imported).
  Rows are extracted by `packages/finance-core/src/pdf.ts`, a port of Rails' `PdfStatementExtractor`. A PDF where every
  amount has a clear sign and the year is known is imported straight away; otherwise it opens a review (correct or leave
  out rows, then confirm), like the website. Drafts stay in memory and are never saved or uploaded.
- **Least privilege**: the app's permissions (`src-tauri/capabilities/default.json`) allow SQLite,
  the save dialog, and writing to the file the person picked. There is no file-system read scope;
  imports use the standard file picker.
- **No analytics, crash reporting, or financial sync.**
- **Managing data** (the Data page):
  - Lists the cloud and every local database side by side, each with its name, size (actual SQLite size locally, approximate in the cloud), its share of the total, contents, date range and last change, plus a bar of the shares. Databases on other devices are stored there and are not counted.
  - *Delete database* needs the typed confirmation word ("delete", localized) and says it cannot be undone. A local database is emptied and removed from the list (the last one is emptied and kept). The cloud database is deleted with `DELETE /api/client/v1/finance?confirm=delete`; website copies on devices become the devices' own data. Single statements can still be removed one at a time (`DELETE …/finance/statements/:id` in the cloud).
  - *Sync* copies what one database has into another (local → local, cloud → local, local → cloud). Only statements the target does not have (matched by file hash) are added; nothing is deleted from either side, so it is safe to repeat. The panel shows each side's statement/transaction counts and last change, and previews what will be added. Local → local goes straight between the two files; it uses the cloud only if "Also keep a copy in the cloud" is ticked.
  - **What leaves the device**: only when the person syncs *to the cloud* (or ticks the box), one statement per `POST …/finance/statements` request from `src/services/cloudUpload.ts` (the only code that sends statements; enforced by `test/privacy.test.ts`). Nothing is ever sent automatically.
- **Local database metadata on the website** (automatic for every signed-in person; there is no switch and no separate Settings section. Each database card on the Data page shows "Metadata Last Updated"):
  - The app reports ONLY: a random database id, a random device id, the database name, the device name, size in bytes, statement/transaction/rule counts, first and last transaction date, last modified time and when the app session started. Never statement names, descriptions, amounts, balances, merchants, categories, accounts, paths or files. The request body is built from an explicit allowlist (`REPORT_FIELDS` in `src/services/localReport.ts`); the server rejects any other field; `test/privacy.test.ts` pins both.
  - One-way: `PUT /api/client/v1/devices/:device/databases/:database`, `DELETE` the same path (a database was deleted) and `DELETE /devices/:device` (switched off, forget everything). The server only displays it; no route can command a device.
  - Reported when the app opens and the person is signed in, and after creating, renaming or deleting a database, or finishing a sync. There is no timer and no background work. Unchanged data is not resent.
  - Offline, everything keeps working. Removals of deleted databases are queued in `localStorage` and retried with their original sequence number until the server confirms; the UI says "pending" until then. Per-device sequence numbers make retries and late, older reports harmless on the server (a deleted database stays deleted).
  - Database ids live in each database's `settings` table (`report_id`), stay the same across renames and disappear with the database.
- **Reporting, sync and backup are three separate things** (never merged in code or UI):
  - *Metadata Last Updated*: when the server last accepted a metadata report (above). Automatic. Moves no financial data. `reporting.ts` and `localReport.ts` import no sync, transfer, upload or backup code (tested).
  - *Last Synced*: set only when the person presses **Sync Now** on the Data page and then **Confirm Sync**. The confirmation names the source, the destination, the data scope and where the data travels. Metadata reporting never starts a sync, and the automatic website download does not set this.
  - *Last Backed Up*: cloud backup is **not implemented**. The Data page shows **Back Up Now** disabled with "Coming Soon" and no backup is ever made. When built it must be explicit, encrypted, show size/destination/storage before confirming, and be restorable; it will be independent of reporting and sync.
- **CORS**: every method the apps use (GET, POST, PUT, PATCH, DELETE) must be allowed for the app origins in `config/initializers/cors.rb`; a missing one fails silently in the app. `test/integration/client_api_cors_test.rb` checks them.
- **Migrations**: `src-tauri/migrations/NNNN_*.sql`, applied in order by the SQL plugin. Never
  edit a shipped file; add a new numbered one that migrates data in place. Tests apply the same
  files.

### On-device OCR (photos and scanned PDFs)

Every engine returns the same `OcrResult` contract (`packages/finance-core/src/universal/ocr.ts`: lines, words, boxes in
upright-page pixels, confidence, engine id/version, page errors, unsupported capabilities) and feeds the same layout,
validation, preview and import pipeline as CSV. Text PDFs keep the text extractor; only pages without a usable text layer
are rendered locally (pdf.js, ~300 dpi, at most 24 MP per page) and sent to OCR as images, in page order.

| Platform | Engine | Status (2026-11-09, this Mac) |
|---|---|---|
| macOS | Apple Vision (`src-tauri/ocr-apple/BillieVisionOCR.swift`, linked by `build.rs`, command in `src/ocr.rs`) | Compiled into the app; FFI tested by `cargo test`; real images tested (`test/ocr/appleVision.real.test.ts`, also with networking denied by `sandbox-exec`) |
| Web (browsers) | Tesseract 5 WebAssembly via tesseract.js 7, assets served from the app origin (`/ocr/`, `vite.config.ts`) | Real images and an image-only PDF tested in Chromium with all non-local hosts blocked and offline after first use (`test/ocr/browser.real.test.ts`) |
| Windows | Same bundled Tesseract WebAssembly engine inside WebView2 (Chromium) | Not built or run on Windows. The Chromium test is the closest evidence. |
| iOS | Apple Vision via `src-tauri/plugins/billie-ocr` (shares the Swift file) | Written; **not compiled** (no full Xcode here) |
| Android | ML Kit Text Recognition v2, bundled Chinese+Latin model, via `src-tauri/plugins/billie-ocr` | Written; **not compiled** (no JDK / Android SDK here). Telemetry removal in the manifest is unverified. |

Financial safety: OCR confidence is shown but never trusted on its own. An OCR row is only "ready" when the statement's own
balances prove its amount and direction (previous balance + amount = printed balance, or printed opening + rows = printed
closing); every other row needs a decision, and the original page is shown beside the rows with the row highlighted.
Unreadable amounts are rejected, never repaired; missing pages must be acknowledged; repeated page headers are skipped
visibly; a line printed twice with the same balance is flagged. Tesseract cannot tell Simplified from Traditional Chinese,
so it returns both readings and the person chooses the script (amounts and dates are identical in both).

Privacy: no image, recognized text or financial value leaves the device. Apple Vision runs locally (language correction
off, so amounts are never "corrected"). The Tesseract worker loads only `/ocr/worker.min.js`, `/ocr/core/*-lstm.wasm.js`
(WASM embedded) and `/ocr/lang/{eng,chi_sim,chi_tra}.traineddata.gz`; the adapter refuses to start without these local
paths, so tesseract.js's jsDelivr defaults can never be used. The CSP gained `connect-src 'self'` (the app bundle only).
Only `location: "device"` engines can be registered.

First use in a browser downloads about 17 MB of OCR files from the same origin (one 3.7 MB core is used, chosen by SIMD
support, plus 6 MB of models); `public/ocr-sw.js` caches those files (and nothing else) so OCR then works offline. The
installed apps bundle them. Licences: tesseract.js and tesseract.js-core Apache-2.0; models from tessdata (Apache-2.0)
packaged by @tesseract.js-data (MIT); Apple Vision and ML Kit are platform/SDK components under their vendors' terms.

Tests regenerate nothing at run time: synthetic statements (`test/ocr-fixtures/`, made by `generate.py`) have ground truth
in `truth.json`; each real-engine test prints recall, field accuracy and review rate and asserts that no row is ever
marked ready with a wrong date, amount or direction.

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
- PDF amounts: Rails matches with a lookbehind, which Safari 15 cannot parse; the port captures the boundary instead.
  PDF text itself comes from pdf.js rather than pdf-reader, so `fixtures/pdf/*.txt` pin the extraction from page text onward.

When you change categorizer rules in Rails, regenerate the fixtures and update
`packages/finance-core/src/categorizer.ts`.

## Statement country / region

The Import page has an optional **Country / Region** dropdown (19 regions, default **Not specified**). Names follow the interface language (for example Mainland China / 中国大陆 / 中國大陸). The default is never taken from GPS, IP, the device or the account's usage region.

Each imported file is also checked by a deterministic, rule-based detector (`packages/finance-core/src/regionDetect.ts`; no network, no model). It scores evidence found in the file: bank names, routing numbers / IBAN / sort code / BSB / IFSC / CLABE (checksums verified where they exist), bank addresses, regional payment networks (Zelle, Venmo, Interac, PayNow, 轉數快…), and, weakly, currency and date style. USD alone, or Chinese-language text, never makes a confident detection. The result is `detectedRegion`, `confidence` (high / medium / low), `evidence` and `conflictingEvidence`.

The validator never changes a selection by itself:

- Nothing selected + High confidence: a suggestion with **Use detected region**.
- Selection matches: nothing is shown.
- Selection conflicts with High-confidence evidence: a non-blocking warning with **Keep my selection** / **Use detected region**.
- Weak or no evidence: nothing is shown.

The notice appears above the import preview or PDF review, and stays in Import history for imports already saved (accepting there also reclassifies automatic categories). Migration 6 stores the selection and the detection separately on each statement: `region` (in effect), `region_source` (`user`, `user_confirmed`, `suggestion`, or NULL), `detected_region`, `region_confidence`, and `region_evidence`. Evidence holds rule labels only, never text or numbers from the file. Region data stays on the device and is not uploaded.

## Custom categories

Each local database keeps its own custom categories (`custom_categories`, migration `0003`, which also rebuilds `transactions` and `merchant_rules` without the old fixed category list while keeping every row). The same limits as the website apply (`packages/finance-core/src/categories.ts`). Syncs and website downloads bring custom categories along (`GET /api/client/v1/finance/categories`); a name that can't be added (limit reached) is filed as Uncategorized.

## Optional AI analysis (Phase 5, not built yet)

AI categorization is built (see *Local-first privacy*). AI analysis of aggregates is not yet.

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
