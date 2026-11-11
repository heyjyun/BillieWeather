> Preserved from the 2026-11-11 QA session (session scratchpad). Its fixes landed in commit `2c3de35 fixdrop1`.
> Screenshots (~32 MB) were not copied into the repository, so the image links below are not available here.
> Machine-readable results are in `evidence/`; the audit scripts are in `scripts/` (they read a dev-only `preview-pass.txt`, which is intentionally not included).

# BillieWeather — final cross-platform UI/UX QA report

Date: 2026-11-11 · Base commit: `4e49d24 UIchange` (already on `origin/main`) · QA fixes: **uncommitted**, not pushed or deployed.

## 1. Result at a glance

| Check | Website (Rails) | Universal client (browser build of the app) |
|---|---|---|
| Automated layout and translation audit (6 languages × desktop 1440 / tablet 820 / phone 390) | 306 page renders, **0 findings** (before fixes: 63 renders had horizontal overflow) | 147 screen renders, **0 findings** (before fixes: Settings tab off-screen on phones, page overflow on Dashboard and Reports) |
| Interaction checks (desktop and phone) | **69/69** pass | **48/48** pass |
| Unit/integration tests | **518 tests, 0 failures, 0 errors** (before: 2 errors) | **37 files, 461 tests pass**; typecheck clean |
| Same design tokens | 19 of 21 computed style properties identical in light *and* dark mode; the 2 differences (nav item height, input size) are now fixed | ← |
| Data preserved | Dev DB: only the preview test account gained records | Local SQLite on this Mac: integrity `ok`, schema 6, newest import Nov 7 (before this work) |

The audit flags: real horizontal page scrolling; elements past the viewport edge; text under 11.5px; text clipped without an ellipsis; visible translation keys, `%{…}`/`{…}` placeholders, `undefined`/`NaN`/`[object Object]`; `translation_missing` markers; HTTP ≥ 400; and JavaScript errors. Scripts: `rails-audit.cjs`, `uni-audit.cjs`, `web-interactions.cjs`, `uni-interactions.cjs`, `consistency.cjs` in the scratchpad.

## 2. Issues found and fixed

| # | Issue | Where | Root cause | Introduced by redesign? | Fix |
|---|---|---|---|---|---|
| 1 | Page scrolled sideways by up to 591px on phones/tablets (Statements, Dashboard, Transactions, Categories, Tax, Features) | Web | The screen-reader-only "Action" label in table headers is `position: absolute`; its scroll wrapper wasn't positioned, so it escaped the clipping | No (old CSS had the same rules) | `.bw-table-scroll { position: relative }` (web and app) |
| 2 | Single-column layouts below 1100px could grow to the width of their widest table | Web | `grid-template-columns: 1fr` cannot shrink below its content | No | `minmax(0, 1fr)` everywhere, `min-width: 0` on grid children |
| 3 | Table action links ("Review", "Remove", "Details") wrapped one letter per line (rows ~140px tall) | Web | `.bw-panel { overflow-wrap: anywhere }` lets table cells shrink to one character | No | Normal wrapping in table cells; phone transaction tables become stacked cards like the app |
| 4 | Public header overflowed at tablet width (820px) | Web | Theme button added to an already-full header | **Yes** | Links move to their own row below 1100px |
| 5 | Phone tab bar pushed **Settings** off-screen (unreachable) | App | 12px labels plus `1fr` columns | **Yes** (when labels were raised to 12px) | `minmax(0, 1fr)` columns; long labels hyphenate |
| 6 | Period picker widened the page on phones (Dashboard, Reports) | App | `.bw-main` grid column could not shrink | No | `grid-template-columns: minmax(0, 1fr)` |
| 7 | Tab-bar labels 11px; `<small>` rendered at 10.8px (storage sizes on Settings and Data) | Both | Browser default `small { font-size: smaller }` | Partly | 12px minimum everywhere |
| 8 | `color-mix()` used in 14 places, but the apps target Safari 15 (iOS) and Chrome 105 (Windows WebView2), which don't support it: focus halos, row hovers, the forecast legend and the translucent header would silently disappear there | Both | Newer CSS than the documented targets | **Yes** | 6 `rgba` tokens; a test now rejects `color-mix`, `oklch`, `@container`, `@layer` |
| 9 | Form controls differed (web 40px/14px, app 44px/13px), and under 16px, so iOS zooms on focus | Both | — | Partly | 44px controls, 14px text, 16px on phones, in both |
| 10 | Sidebar items 40px on web vs 44px in the app | Both | — | **Yes** | Both use the 44px `tap-target` token |
| 11 | Standalone text links ~20px tall on phones (WCAG 2.5.8 asks ≥ 24) | Web | — | No | 32px minimum on phones |
| 12 | Files dropped from Finder onto the installed app's Import zone were ignored | macOS / Windows apps | Tauri's native drop handler consumes OS drops | No | See §6 |
| 13 | 2 Rails test errors | Bullet Train pages | See §5 | No | Translation keys added |

## 3. Feature access: website vs app

Both have every page they had before; nothing was removed. They have always offered different feature sets: the app is the local-first client, and forecast/AI/tax were never ported to it.

| Feature | Website | App | Notes |
|---|---|---|---|
| Overview / dashboard (period presets, totals, monthly chart, spending mix, recent activity) | ✓ sidebar | ✓ tab | Same KPI tiles and chart tokens |
| Statement import | ✓ **Statements** (added to the sidebar in the redesign) | ✓ Import | Web: CSV + text PDF, drag-and-drop. App: CSV/TSV/XLSX/OFX/PDF/OCR, preview, region detection |
| Transactions, search/filter, category correction | ✓ | ✓ | Phone: stacked cards on both now |
| Categories and AI categorization (with consent) | ✓ | ✓ | |
| Cash flow forecast and scenarios | ✓ | — | Not implemented in the app (README: Phase 5) |
| Billie Insights / AI analysis | ✓ | — | Not implemented in the app |
| Tax preparation | ✓ | — | Not implemented in the app |
| Reports / export (CSV, XLSX) | ✓ via Dashboard "Export report" → `/app/report` | ✓ Reports tab | |
| Data and storage | ✓ Settings › Your database | ✓ Data tab (databases, sync, typed-word delete) | |
| Settings: region, language, nickname, privacy deletion | ✓ | ✓ (account details; privacy deletion via the website) | |
| Appearance: theme System/Light/Dark | ✓ header menu | ✓ Settings › Appearance | Per device, never sent |
| Collapsible sidebar | ✓ | ✓ | Remembered per device |
| Admin pages | ✓ (admins only) | — | Not audited: needs an admin account |

## 4. Design-system consistency (computed styles, same account and data)

19 of 21 probed properties were identical in **light and dark**: sidebar background, active nav background/text, page and card backgrounds, card border/radius/shadow, KPI value size and label color, h1 size and color, eyebrow color, body font stack, balance tile, positive-amount color, brand mark, and the primary button (`#C2357F`, white, 8px radius, 13px/600, 44px). The two differences, nav item height and form controls, are fixed (#9, #10).

## 5. The two pre-existing Rails test errors

Both errors came from Bullet Train framework pages (team settings and the API's OpenAPI document), not from the finance UI or the redesign. Both are fixed with English translation keys; the other five languages fall back to English (`config.i18n.fallbacks = [:en]`).

1. **`Account::TeamsControllerTest#test_should_get_edit`**: `Translation missing: en.teams.fields.locale.options`.
   - **Cause:** Bullet Train 1.45's team form shows a language picker when more than one locale exists. It passes `t("locale.locales")`, a Hash, to the buttons partial, which now only accepts an Array. The partial then falls back to looking up `teams.fields.locale.options`, which neither the gem nor the app defines. It started failing once the app added its six languages.
   - **Fix:** `config/locales/en/teams.en.yml` gains `teams.fields.locale.options`, the six languages named in their own scripts.
2. **`Api::OpenApiControllerTest#test_OpenAPI_document_is_valid`**: `Translation missing: en.users.fields.usage_region.heading`.
   - **Cause:** the user serializer (`api/v1/users/_user.json.jbuilder`, commit `99f9d3d addRegionSelect`) exposes the app-added `usage_region` column. Bullet Train's OpenAPI generator requires `heading`, `api_title` and `api_description` for every field.
   - **Fix:** `config/locales/en/users.en.yml` documents `usage_region`.

Result: both tests pass, and the full suite is 518 tests, 0 failures, 0 errors.

## 6. Tauri drag-and-drop

**Finding (from the actual sources this app compiles: tauri 2.12.5, tauri-runtime-wry 2.12.3, wry 0.57.1):**
- With the default `dragDropEnabled: true`, Tauri installs a native handler that always returns `true`.
- On macOS, wry then answers the OS itself (`perform_drag_operation` → `YES`) and never calls WKWebView. On Windows the return value is ignored and the drop goes to Tauri.
- So the web page, including the Import `<input type="file">`, never receives the file.

**Fix:**
- `"dragDropEnabled": false` on the window, so OS drops go to the web view and its file input, exactly like a browser.
- `src/services/dropGuard.ts` cancels drops anywhere that isn't an enabled file input, so the web view can't navigate to a dropped file.
- Privacy is unchanged or better: no file path is exposed to JavaScript (Tauri's handler would have exposed paths), and capabilities and CSP are untouched.

**Verification on this Mac** (real OS drag sessions synthesized with CGEvents). Two isolated QA builds of the actual Rust shell, using identifier `com.billieweather.qa`/`dropqa`, so a separate data folder; no sign-in and no keychain use. They load a page with the app's real stylesheet, real `dropGuard` module and real drop-zone markup:

| Build | Drop on the Import zone | Drop elsewhere |
|---|---|---|
| Control (`dragDropEnabled: true`, the shipped setting) | ✗ OS accepts, page never receives the file ("waiting") | page stays |
| Fix (`false` + guard) | ✓ `RECEIVED sample-b.csv · 3 rows` | ✓ page stays, nothing opened |

![control](drop/DropQAControl-outside.png)
![fix](drop/DropQAFix-outside.png)

Also covered: 4 unit tests (guard behavior and the config pin).

Not verified: Windows (WebView2 — Tauri documents disabling its handler as the way to get HTML5 drops there); iOS and Android (wry doesn't support its drop handler on mobile, so the setting has no effect there).

## 7. Languages

All six (English, 简体中文, 繁體中文, 日本語, 한국어, Español) were audited on every page at three sizes in both implementations: no missing keys, raw placeholders or overflow after the fixes. Spanish produces the longest strings and drove fixes #1–#4.

Long Spanish button labels on phones now wrap, for example on Tax: "Pedir a Billie recomendaciones para preparar…". Shell controls (Statements, collapse/expand, theme names) are covered by `billie_design_shell_test.rb` for en/zh-CN/zh-TW, and the app's i18n test checks key parity for all six.

## 8. Data preservation

- **Code:** the redesign commit and the QA fixes add no migrations and change no models, services, controllers, routes, `finance-core`, `shared-types`, `reporting`, Tauri migrations, or the app's data services and hooks. The only new service files are `theme.ts` (localStorage) and `dropGuard.ts` (cancels events).
- **This Mac's local database** (`com.billieweather.client/billieweather.db`, inspected on a copy, which was then deleted): `quick_check` ok, migration 6 of 6, 72 statements / 2,687 transactions, newest import 2026-11-07. The file's modification time (Nov 10 23:39) is when the built app was launched for verification.
- **Rails development database:** since the session started, only `design-preview@billieweather.test` was created, with 1 statement and 80 transactions. No other account's records were created or updated. The website checks submit only the sign-in form; dialogs are opened and closed, never confirmed.
- **In the app QA:** the browser build keeps data in memory; delete confirmations are cancelled, not confirmed. No request went anywhere except the app itself and the local BillieWeather server, and no statement was uploaded (checked in `uni-interactions.cjs`).

## 9. Platform matrix

| | Web | macOS | Windows | iOS | Android |
|---|---|---|---|---|---|
| Build | n/a (static CSS/JS) | ✓ `desktop:build` `.app` + `.dmg`; QA builds ✓ | **Not built** (needs Windows; CI builds it) | **Not built** (needs full Xcode; only Command Line Tools here) | **Not built** (no JDK 17/Android SDK/NDK/rustup) |
| Ran the real app | ✓ Chromium | ✓ launched with existing local DB; QA builds driven with real drags | ✗ | ✗ | ✗ |
| Layout audit | ✓ 306 renders | ✓ via the identical web bundle in Chromium (147 renders). WKWebView itself not automated except the drop harness | Proxy only: Chromium ≈ WebView2 | Proxy only: Chromium at 390px; WebKit not automated (no Playwright WebKit installed) | Proxy only: Chromium at 390px |
| Engine compatibility | ✓ | Safari 15 target: unsupported CSS removed (#8) | Chrome 105 target: unsupported CSS removed (#8) | Same as macOS + 16px inputs (#9) | Android WebView is Chromium |
| Safe areas | n/a | n/a | n/a | `env(safe-area-inset-*)` in CSS; **not seen on a device** | Same; **not seen on a device** |
| Drag-and-drop | ✓ | ✓ fixed and verified | Fixed in config; **untested** | n/a | n/a |
| Theme / sidebar / i18n | ✓ | ✓ (same bundle) | untested | untested | untested |

## 10. Screenshots

Website (left) and app (right): desktop dashboard, English

<img src="web/desktop-en-dashboard.png" width="49%"> <img src="app/desktop-en-dashboard.png" width="49%">

Phone transactions (stacked cards on both) and phone import

<img src="web/phone-en-transactions.png" width="24%"> <img src="app/phone-en-transactions.png" width="24%"> <img src="web/phone-en-statements.png" width="24%"> <img src="app/phone-en-import-preview.png" width="24%">

Traditional Chinese: phone dashboard and Settings

<img src="web/phone-zh-TW-dashboard.png" width="24%"> <img src="app/phone-zh-TW-dashboard.png" width="24%"> <img src="web/phone-zh-TW-settings.png" width="24%"> <img src="app/phone-zh-TW-settings.png" width="24%">

Tablet (820px): public header and statements

<img src="web/tablet-en-home.png" width="49%"> <img src="web/tablet-en-statements.png" width="49%">

Dark theme: web dashboard, web forecast (Korean), app dashboard, app import preview, phone transactions (web, Japanese; app)

<img src="dark/web-desktop-dashboard.png" width="49%"> <img src="dark/web-desktop-forecast.png" width="49%">
<img src="dark/app-desktop-dashboard.png" width="49%"> <img src="dark/app-desktop-import-preview.png" width="49%">
<img src="dark/web-phone-transactions.png" width="24%"> <img src="dark/app-phone-transactions.png" width="24%">

All captures: `web/` (102: every page × desktop/tablet/phone × en/zh-TW), `app/` (51: every screen including the import preview), `dark/`, `drop/`.

## 11. Not verified / remaining limitations

- Windows, iOS and Android: not built or run here (see matrix). Mobile safe areas and touch behavior need a device or simulator.
- WebKit rendering was only exercised through the macOS QA builds (drop harness), not page by page.
- Not exercised on purpose (they write data or need outside services): confirming imports or category edits on the website (covered by existing Rails integration tests); AI analysis and AI categorization calls; Google sign-in; admin pages; the web PDF review page (needs an uncertain PDF draft).
- The app's keychain service name is hardcoded (`src-tauri/src/session.rs`: `com.billieweather.client`), so any build with a different identifier would share and overwrite the real sign-in token. That's why the QA builds never signed in. Worth parameterizing before anyone builds QA/beta variants.
- Unchanged by design: the app doesn't have forecast, insights or tax preparation (§3).

## 12. Uncommitted changes from this QA pass

- **Website**
  - `public/billie.css`: fixes #1–4, 7–11
  - `app/views/finance/shared/_transactions_table.html.erb`: `bw-tx-cards` hook class
- **App**
  - `clients/universal/src/styles.css`: fixes #1, 5–9
  - `src/main.tsx`
  - `src/services/dropGuard.ts` (new), `test/dropGuard.test.ts` (new)
  - `src-tauri/tauri.conf.json`: `dragDropEnabled: false`
- **Tokens:** `packages/design-tokens/src/tokens.ts` (6 rgba tokens), regenerated `dist/tokens.css` and `public/billie-tokens.css`, `test/tokens.test.ts` (engine-compatibility test)
- **Rails errors:** `config/locales/en/teams.en.yml`, `config/locales/en/users.en.yml`
- **Docs:** `clients/universal/README.md`, `packages/design-tokens/README.md`
