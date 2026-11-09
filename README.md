# BillieWeather

A personal finance workspace built with [Bullet Train](https://bullettrain.co/), Rails, and PostgreSQL. The first release focuses on U.S. personal finances and tax-record preparation.

## Local development

Use the Ruby version in `.ruby-version` and Node version in `.nvmrc`. This checkout uses mise for Ruby. PostgreSQL and Redis must be available locally; short Active Job tasks run inline, with no separate Sidekiq worker.

```bash
mise exec -- bundle install
corepack enable
yarn install
mise exec -- bundle exec rails db:prepare
mise exec -- bin/dev
```

Open `http://localhost:3000`. If a server was already running when code or dependencies changed, stop and restart that server. A Rails-only preview is also possible with `mise exec -- bundle exec rails server`; the finance pages use `public/billie.css` without requiring a JavaScript build.

Register a new account; no shared demo login or preloaded financial data is created. In Upload Statements, download the sample CSV and import it to try the complete flow.

## Languages

The main app supports English, Simplified Chinese, Traditional Chinese, Japanese, Korean, and Spanish. Open the language menu in the header on the home, authentication, or finance pages and choose **English / 简体中文 / 繁體中文 / 日本語 / 한국어 / Español**. The first visit follows the browser language; an explicit choice is remembered in this browser for one year and takes priority over browser and account defaults. It remains selected after signing in or out. Language links preserve current search and date filters.

Navigation, forms, dates, categories, validation messages, forecast explanations, and newly generated basic/AI analysis use the selected language. Previously saved analysis and PDF-specific warnings retain their original language; generate a new analysis to use the current language. User-provided descriptions, bank names, and custom account names remain as entered. CSV headers, stored categories, currencies, and financial calculations stay consistent between languages. Changing the interface language does not change the app's U.S. tax-preparation scope or add support for other countries' bank statement formats. Restart Rails after adding the new locale configuration.

## Usage region

Users must select a usage region during email registration. The region can be changed later in **Settings** (`/app/settings`) or the account profile, but cannot be cleared. The fixed list has 249 standard region codes plus the special **Global Citizen** choice, displayed first. Names are shown in the selected interface language. Global Citizen is stored as the application-specific two-letter code `XG`, making 250 supported choices in total; it satisfies the required selection like any other supported region. The interface labels this field as a region; the `CN` choice is **Mainland China** in every language, alongside separate regional choices such as Hong Kong, Taiwan, and Macao. The stored value is the two-letter `users.usage_region` code.

New accounts require a valid region in Rails and PostgreSQL. Existing accounts with no saved region are marked `usage_region_pending` by the migration, rather than assigned a guessed location. They can authenticate, then must choose a region before accessing the app; a valid selection clears the pending flag. Attempts to save an empty or invented region are rejected. Region-list changes require a new migration to update the database allowlist. The usage region is separate from the tax-jurisdiction profile setting.

New Google registrations also require a region before account creation. A verified identity is held in the encrypted session for up to 10 minutes, then the user chooses a region. The app rechecks identity ownership and registration eligibility before creating the account; access and refresh tokens are not saved. Existing Google accounts with no region are directed to Settings after login.

Internal OAuth service principals share the users table but are not human registrations and are exempt from region selection. Pending human API users receive a usage_region_required response until they complete Settings.

Apply the region migrations before running this version, then restart Rails. Production migration requires explicit authorization for the production database.

## Working flows

| Page | Behavior |
| --- | --- |
| `/` | Landing page with registration and login links |
| `/users/sign_up`, `/users/sign_in` | Bullet Train / Devise registration, login, logout |
| `/app` | Income, spending, categories, monthly totals, recent transactions, date presets and custom periods |
| `/app/statements` | CSV import, PDF review, duplicate-file checks, deletion |
| `/app/transactions` | Search, filters, pagination, CSV export, classification and corrections |
| `/app/categories` | Category details (counts, money in/out, share of spending, transactions per category), custom categories, one-click AI categorization |
| `/app/forecast` | Choose Prophet, Chronos-2, or historical-average projections and percentage scenarios |
| `/app/insights` | Basic analysis, optional AI analysis, U.S. personal tax-record checklist |

Users can access only their own finance records. Transfers and excluded transactions do not contribute to income, expenses, or projections. Tax-review flags organize supporting records; they do not establish deductibility.

## Google sign-in

Registration and login include Continue with Google. The button is disabled until both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are configured; email registration/login stays available.

1. In the [Google Auth Platform](https://console.cloud.google.com/auth/overview), configure the app branding/audience and create an OAuth client of type Web application. If the app is in testing, add the Google accounts you will test with to its test users.
2. Add these Authorized redirect URIs exactly (replace the production hostname with your Render or custom domain):
   - `http://localhost:3000/users/auth/google_oauth2/callback`
   - `https://YOUR-APP.onrender.com/users/auth/google_oauth2/callback`
3. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server. Locally, add the two keys to ignored `config/application.yml` using YAML syntax, or export environment variables; `.env.example` is a reference and is not loaded automatically. In Render, add the values under the web service's Environment settings. Restart the local server or redeploy after configuration.

Only OpenID, email, and basic profile scopes are requested. A first Google signup creates a normal user and workspace; subsequent logins use the stable Google subject identifier. When the email already belongs to a password account, the same browser must first complete the existing password login within 10 minutes to connect Google. Emails alone never merge accounts, and existing financial records stay with their original user. Locked accounts cannot use Google to bypass a lock. Accounts requiring a local authentication code continue through password and authentication-code login.

The application stores only the Google subject identifier with the user, without Google access/refresh tokens. Google cancellation or missing configuration returns to the normal login. Live sign-in requires real Google credentials and consent; automated tests mock Google callbacks and validate initiation/state/PKCE without external sign-in. See [Google's web-server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server). The button uses Google's [official branding asset](https://developers.google.com/identity/branding-guidelines).

## Dashboard date ranges

Choose All time, This month, Last month, Last 30 days, This year, or Last year, or enter both custom dates and select Apply dates. Both endpoints are included. The heading shows the selected period even when transactions cover fewer days. The presets use the account timezone, falling back to America/Chicago. GET links can be bookmarked and never change the recorded transactions.

Income, expenses, net flow, categories, monthly figures, counts, and recent transactions use the same dates. The chart shows the latest six months with activity; the monthly figures expand to the entire selected period. View all carries the dates into Transactions, filters, pagination, and CSV export. Cash balance remains the latest automatic account total (or an explicitly saved manual override), independent of the date filter. Insights continue to use full imported history. Invalid ranges show an error and hide totals rather than displaying unfiltered results.

## Import formats

Select up to 10 CSV and/or text-based PDF files together, at most 2 MB per file and 10 MB combined. Each file has its own result: imported, needs review, or not imported. A bad or duplicate file does not undo successful files. Pending PDF reviews remain listed on Upload Statements, scoped to your account. Review drafts expire after 30 minutes. If processing takes too long, remaining files are explicitly marked not processed and can be retried in a smaller batch.

CSV: UTF-8, maximum 2 MB / 5,000 rows. Use `Date,Description,Amount` or `Date,Description,Debit,Credit`; optional Currency, Category, and Type columns are supported. Dates are `YYYY-MM-DD` or U.S. `MM/DD/YYYY`. Date columns are detected automatically: Transaction Date takes priority over Date, followed by posting/posted/booked date aliases, regardless of column order. Spaces, underscores, hyphens, and capitalization are normalized. The import confirmation names the date column used. All rows use that column; invalid or empty dates fail the complete import instead of switching to another column. Positive amounts mean money in, negative amounts mean money out. Debit/Credit columns must follow this cash-flow convention, including for card exports. Amounts allow up to two decimal places. Header aliases are implemented in `Finance::StatementImporter`.

PDF: text-based, unlocked statements, maximum 2 MB / 20 pages / 500 candidate rows. The parser recognizes date-prefixed lines and detects statement years for short `MM/DD` dates where possible. Clear PDFs import automatically; uncertain years, signs, or columns open an editable review before importing transactions. Unsigned values and ambiguous amount/balance columns remain blank for manual confirmation. Compare counts and totals with the original: layouts vary and wrapped or differently arranged rows can be missed. Scanned/image-only PDFs need OCR or a CSV export; OCR is not included in this release.

Exact duplicate files are prevented per account. Overlapping statements with different contents can still duplicate transactions and require review. Original files are not retained. Parsed PDF drafts expire after 30 minutes and are removed on subsequent account activity; expiry is not a scheduled physical-deletion guarantee.

## Automatic account balances

Starting cash defaults to the sum of each identified checking/savings account's latest dated statement balance. Uploading another month for the same account replaces its contribution, rather than adding the months together. Credit-card/loan balances are excluded from cash. Account identity uses the institution, last four account digits, and cash/credit kind; full account numbers are never saved as account metadata. Review detected matches in Statement history; different accounts with the same bank and last four digits can be assigned separately.

CSV account detection reads optional Bank, Account Number, and Account Type (Checking/Savings/Credit Card) metadata; Balance, Running Balance, Ending Balance, or Closing Balance supplies the amount. Text-based PDFs can supply labelled bank/account details and a printed closing balance. A transaction-only export cannot establish a bank balance. If the newest statement for an account has no usable balance/date, that account is omitted and the total is explicitly incomplete; no known balances is unavailable, not zero. Future-dated observations are not counted. Accounts can have different statement dates, shown in the forecast breakdown: these are dated snapshots, not live bank balances.

Older imports have no retained original file and may lack both account metadata and saved closing balances. Statement history shows Saved balance so these cases are distinguishable. Selecting an account alone does not recover a missing balance; it must come from the original statement rather than transaction net flow. Select an existing account or enter its bank, account label, last four digits, and cash/credit kind; no manual balance calculation is required. The optional manual override remains available and can be switched back with Use automatic account total. Historical-average projections use at most the last 90 calendar days; the selected model determines the history used for pattern-based forecasts.

## Cash flow forecasting models

In `/app/forecast`, choose **Prophet**, **Chronos-2**, or **Historical average** under Forecast model, then select Update forecast. The result names the model actually used. If a model lacks sufficient history or its backend is unavailable, a visible notice explains the historical-average fallback and the selected model stays selected. The server default is Prophet; `FORECAST_ENGINE=prophet`, `chronos`, or `linear` changes that default, while each explicit page selection takes precedence.

Prophet runs inside Rails through `prophet-rb`. Chronos-2 calls the separate [BillieForecast Python service](billieforecast/README.md), which must be running with its `chronos` backend:

```bash
cd billieforecast
cp .env.example .env
uv sync --extra chronos
uv run --extra chronos billieforecast
```

In another terminal, set `BILLIEFORECAST_URL=http://127.0.0.1:8000` in the Rails process environment or ignored `config/application.yml` using YAML syntax. If the Python service has `BILLIEFORECAST_API_KEY` set, configure the same key in Rails. Restart Rails after changing configuration. Rails sends daily income/expense aggregates without transaction descriptions. The Python service's `.env` is loaded by Python; the root `.env.example` remains a reference only.

The first Chronos request downloads and loads weights. Before using the Rails page, run `uv run --extra chronos python scripts/smoke.py` from `billieforecast/` in another terminal to warm the service with synthetic data; provide `BILLIEFORECAST_API_KEY` in that terminal's environment when required. Rails allows 120 seconds for reading a prediction response, so a cold model download may otherwise trigger a visible fallback.

For deployment, set `BILLIEFORECAST_URL` to the Python service's reachable address. `localhost` inside a Render Rails container refers to that container, so a separately deployed Python service needs its own address. The existing `render.yaml` does not provision this model service.

Predictions start from the displayed cash balance, which may be a dated statement snapshot. They do not retrieve a live bank balance or confirmed future payments. Prophet's shaded envelope is an illustrative combination of daily income/spending bounds, with no calibrated probability for the cumulative balance. Chronos-2 accumulates daily point forecasts and does not display a cumulative probability interval. Model quality should be assessed with historical backtests.

## Analysis and tax preparation

Basic analysis runs locally and is explicitly labeled. Optional AI analysis uses the Responses API and structured JSON outputs. Requests go directly to the official OpenAI API (`https://api.openai.com/v1`). Configure Rails encrypted credentials under `openai` (`api_key`, `model`, optional `reasoning_effort`), or use the corresponding `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_REASONING_EFFORT` environment variables. Nonblank encrypted credentials take precedence. API usage is billed separately from hosting.


AI runs only after an explicit submission and consent. It receives displayed aggregates and saved tax context, with `store: false`; original files, descriptions, email, and bank credentials are not sent. Provider failures are shown clearly. Tests use stubbed requests. Saved analyses show a stale notice after records change.

## Categories and AI categorization

`/app/categories` lists every built-in category plus the person's own (`finance_custom_categories`, up to 50 per account, 40 characters each, names unique ignoring letter case and never a built-in name). Transactions and remembered rules keep storing the category name as text, so renaming a custom category updates them, and deleting one moves its transactions to Uncategorized and forgets its rules. Custom names are accepted anywhere a category is chosen, in CSV `Category` columns (any letter case), and in statements uploaded from the apps (an unknown name becomes a custom category).

**Categorize with AI** uses the same `openai` configuration as AI analysis (Responses API, structured JSON output with the category names as an enum, `store: false`). It runs only after the consent box is ticked, at most once every 20 seconds per account (`users.finance_ai_categorized_at`, shared by the website and the apps). For up to 150 distinct merchants per run it sends a cleaned description (digit runs such as card, reference and phone numbers, and email addresses removed; at most 80 characters), the direction (in/out) and the category names: no amounts, dates, balances, account details, file names or email. Transfers are never offered, Income only for money in. Only rows that are still Uncategorized change, so categories the person chose are never overwritten, and AI results are not saved as merchant rules. The apps call `POST /api/client/v1/finance/categorize`, which stores nothing and only returns `{key, category}` pairs; the app applies them to its local database. The cleaning rule is `Finance::AiCategorizer.clean_text` in Rails and `cleanForAi` in `packages/finance-core`; keep them identical.

The [IRS document checklist](https://www.irs.gov/filing/gather-your-documents) guides U.S. personal preparation. Bank deposits are not automatically taxable income; payroll deposits are not W-2 wages. The application organizes records and questions; it does not determine deductions, compute tax liability, or file returns.

## Render Free + Neon Free + Render Key Value Free

`render.yaml` provisions one free Web Service and one free Key Value instance. PostgreSQL is external Neon. Set `DATABASE_URL` to the full Neon connection string, including database name and `sslmode=require`. Web and Key Value must share a Render region; choose a nearby Neon region.

Connect this GitHub repository through Render **New → Blueprint**, review plans, and deploy. The build precompiles assets and applies migrations/seeds. `SECRET_KEY_BASE` is generated. `BASE_URL` defaults to Render's `RENDER_EXTERNAL_URL`; override it for a custom domain. Health endpoint: `/up`.

Add optional settings after the first deployment:

| Variables | Purpose |
| --- | --- |
| `FORECAST_ENGINE` | Default forecast model: `prophet`, `chronos`, or `linear`; page selection overrides it |
| `BILLIEFORECAST_URL`, `BILLIEFORECAST_API_KEY` | Chronos-2 service address and optional matching API key |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Optional AI analysis |
| `POSTMARK_API_TOKEN`, `MAIL_FROM` | HTTPS email with a verified sender, including password recovery |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google registration/login after registering callback URLs |
| `BASE_URL` | Custom domain override |

Registration works without welcome email. Password recovery stays unavailable until both email settings are configured. The included Postmark adapter uses HTTPS. Never commit secrets. `.env.example` lists settings but `.env` is not automatically loaded; use environment variables or ignored `config/application.yml` with YAML syntax locally.

Free Web services sleep when idle; free Key Value loses data on restart. Finance records live in Neon. This deployment does not support reliable unattended scheduled jobs. Monitor provider quotas; free hosting does not include AI/email provider usage.

## Verification

```bash
mise exec -- bundle exec rails test test/models/finance test/services/finance test/services/billie_postmark_delivery_test.rb test/controllers/passwords_controller_test.rb test/integration/finance_workflow_test.rb test/integration/finance_forecast_engines_test.rb test/integration/finance_batch_upload_test.rb test/integration/finance_dashboard_period_test.rb test/integration/finance_account_balances_test.rb test/integration/google_sign_in_test.rb test/integration/session_csrf_test.rb
mise exec -- bundle exec rails zeitwerk:check
```

Password login tests explicitly enable CSRF and submit the real form token with its browser session cookie. Verification must run before Bullet Train callbacks read current_user, because successful Devise authentication rotates the token. Invalid or stale submissions return to a fresh login form without authenticating, replaying passwords, or clearing an existing valid login.

The focused suite covers real CSV/PDF parsing, exact amounts, atomic imports, duplicates, forecast scenarios, registration-to-analysis flows, data isolation, formula-safe exports, AI consent/errors, and email readiness. Original Bullet Train framework tests remain available separately.




