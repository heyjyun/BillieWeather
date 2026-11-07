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

## Working flows

| Page | Behavior |
| --- | --- |
| `/` | Landing page with registration and login links |
| `/users/sign_up`, `/users/sign_in` | Bullet Train / Devise registration, login, logout |
| `/app` | Income, spending, categories, monthly totals, recent transactions |
| `/app/statements` | CSV import, PDF review, duplicate-file checks, deletion |
| `/app/transactions` | Search, filters, pagination, CSV export, classification and corrections |
| `/app/forecast` | Current balance plus historical-average projections and percentage scenarios |
| `/app/insights` | Basic analysis, optional AI analysis, U.S. personal tax-record checklist |

Users can access only their own finance records. Transfers and excluded transactions do not contribute to income, expenses, or projections. Tax-review flags organize supporting records; they do not establish deductibility.

## Import formats

CSV: UTF-8, maximum 2 MB / 5,000 rows. Use `Date,Description,Amount` or `Date,Description,Debit,Credit`; optional Currency, Category, and Type columns are supported. Dates are `YYYY-MM-DD` or U.S. `MM/DD/YYYY`. Positive amounts mean money in, negative amounts mean money out. Debit/Credit columns must follow this cash-flow convention, including for card exports. Amounts allow up to two decimal places. Header aliases are implemented in `Finance::StatementImporter`.

PDF: text-based, unlocked statements, maximum 2 MB / 20 pages / 500 candidate rows. The parser recognizes date-prefixed lines, full dates or `MM/DD` with a supplied statement year. Every PDF opens an editable review before importing transactions. Unsigned values and ambiguous amount/balance columns remain blank for manual confirmation. Compare counts and totals with the original: layouts vary and wrapped or differently arranged rows can be missed. Scanned/image-only PDFs need OCR or a CSV export; OCR is not included in this release.

Exact duplicate files are prevented per account. Overlapping statements with different contents can still duplicate transactions and require review. Original files are not retained. Parsed PDF drafts expire after 30 minutes and are removed on subsequent account activity; expiry is not a scheduled physical-deletion guarantee.

## Analysis and tax preparation

Basic analysis runs locally and is explicitly labeled. Optional OpenAI analysis requires server-side `OPENAI_API_KEY` and `OPENAI_MODEL`. Choose a model supporting the Responses API and structured JSON outputs. API usage is billed separately from hosting.

AI runs only after an explicit submission and consent. It receives displayed aggregates and saved tax context, with `store: false`; original files, descriptions, email, and bank credentials are not sent. Provider failures are shown clearly. Tests use stubbed requests. Saved analyses show a stale notice after records change.

The [IRS document checklist](https://www.irs.gov/filing/gather-your-documents) guides U.S. personal preparation. Bank deposits are not automatically taxable income; payroll deposits are not W-2 wages. The application organizes records and questions; it does not determine deductions, compute tax liability, or file returns.

## Render Free + Neon Free + Render Key Value Free

`render.yaml` provisions one free Web Service and one free Key Value instance. PostgreSQL is external Neon. Set `DATABASE_URL` to the full Neon connection string, including database name and `sslmode=require`. Web and Key Value must share a Render region; choose a nearby Neon region.

Connect this GitHub repository through Render **New → Blueprint**, review plans, and deploy. The build precompiles assets and applies migrations/seeds. `SECRET_KEY_BASE` is generated. `BASE_URL` defaults to Render's `RENDER_EXTERNAL_URL`; override it for a custom domain. Health endpoint: `/up`.

Add optional settings after the first deployment:

| Variables | Purpose |
| --- | --- |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Optional AI analysis |
| `POSTMARK_API_TOKEN`, `MAIL_FROM` | HTTPS email with a verified sender, including password recovery |
| `BASE_URL` | Custom domain override |

Registration works without welcome email. Password recovery stays unavailable until both email settings are configured. The included Postmark adapter uses HTTPS. Never commit secrets. `.env.example` lists settings but `.env` is not automatically loaded; use environment variables or ignored `config/application.yml` with YAML syntax locally.

Free Web services sleep when idle; free Key Value loses data on restart. Finance records live in Neon. This deployment does not support reliable unattended scheduled jobs. Monitor provider quotas; free hosting does not include AI/email provider usage.

## Verification

```bash
mise exec -- bundle exec rails test test/models/finance test/services/finance test/services/billie_postmark_delivery_test.rb test/controllers/passwords_controller_test.rb test/integration/finance_workflow_test.rb
mise exec -- bundle exec rails zeitwerk:check
```

The focused suite covers real CSV/PDF parsing, exact amounts, atomic imports, duplicates, forecast scenarios, registration-to-analysis flows, data isolation, formula-safe exports, AI consent/errors, and email readiness. Original Bullet Train framework tests remain available separately.




