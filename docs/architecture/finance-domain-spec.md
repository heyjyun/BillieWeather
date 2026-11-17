# BillieWeather / FinRx Finance Domain Specification (v2)

**Status:** Implemented incrementally, starting 2026-11-15. This document is the contract that the website (Rails/PostgreSQL) and the local apps (Tauri/SQLite) both implement. It extends `financial-database-review.md` (Option C, hybrid ledger) with the manual-bookkeeping scope observed in Suishouji (`docs/research/suishouji-hands-on-inventory.md`).

- **Enums and rules (machine-readable):** `packages/finance-core/schema/financial-schema.json`
- **TypeScript domain:** `packages/finance-core/src/ledger/` (`domain.ts`, `dedupe.ts`)
- **Ruby domain:** `app/models/finance/domain.rb`, which reads the same JSON
- **Contract fixtures:** `packages/finance-core/fixtures/{kind-cases,dedupe-cases}.json` and `fixtures/ledger/*.json`
- **Contract tests:**
  - TypeScript: `packages/finance-core/test/ledger.test.ts`, `clients/universal/test/ledger-store.test.ts`
  - Ruby: `test/services/finance/domain_contract_test.rb`

## 1. Concepts and boundaries

| Concept | What it is | Web (PostgreSQL) | Local (SQLite) |
|---|---|---|---|
| Physical database | A storage container | One Neon database for all users | One SQLite file per slot (`billieweather.db`, `billieweather-2.db`, …, max 8) |
| User | A signed-in BillieWeather account | `users` (+ `finance_owner_uid` uuid, immutable, returned to apps as `owner_id`) | — (the owner is recorded inside each file) |
| Owner binding | Which account a local file belongs to | — | `settings.owner_account_id` (`id:<uuid>`, or `email:<sha256>` before the server sends an id) |
| Workspace | FinRx organisation | Bullet Train `teams` (FinRx only, not used by BillieWeather) | — |
| **Book (账本)** | One bookkeeping scenario, the tenant boundary for financial rows | `finance_books` (one default book per user, created lazily; `book_id` on every new finance table) | **One file = one book.** `settings.book_uuid`. A file is never several books. |
| Account (账户) | Where money is: bank, card, cash, wallet, loan, receivable | `finance_bank_accounts` (extended, see §3) | `accounts` |
| Statement | Evidence: one imported document per account | `finance_statements` | `statements` (plus one hidden *manual-entries container* row per file, `source_format='manual'`, so `transactions.statement_id` can stay NOT NULL without a table rebuild) |
| Original record | The row as the bank printed it | `finance_transactions.original_description` (immutable) and, later, `finance_source_records` | `transactions.original_description`, `source_raw`, `source_ref` |
| Transaction (entry) | One movement of money in one account, with an explicit `kind` | `finance_transactions` | `transactions` |
| Link | Relation between entries: transfer, card payment, refund, duplicate | `finance_transaction_links` | `transaction_links` |
| Category | Two-level income/expense tree | text name on the entry + `finance_category_settings` (parent, kind, order, hidden) | text name + `category_meta` |
| Merchant (商家) / Project (项目) / Tag | Optional dimensions | `finance_merchants`, `finance_projects`, `finance_tags`, `finance_transaction_tags` | `merchants`, `projects`, `tags`, `transaction_tags` |
| Budget (预算) | Spending limit per period, total or per category/project | `finance_budgets` | `budgets` |
| Recurring rule (周期记账) | Template + schedule that creates entries | `finance_recurring_rules` | `recurring_rules` |
| Classification rule | Remembered merchant → category | `finance_merchant_rules` (kept) | `merchant_rules` (kept) |
| AI decision | Who or what set a field, with confidence | `category_source`, `category_confidence`, `category_model`, `user_locked_fields` on the entry; `finance_organize_runs` | Same columns; `organize_runs` |
| Audit event (操作日志) | Append-only record of every change, with undo data | `finance_audit_events` | `audit_events` (append-only, enforced by triggers) |
| Trash (回收站) | Soft-deleted entries | `deleted_at` on entries | `deleted_at` on entries |

## 2. Invariants (enforced in code and checked by tests)

The numbering follows the review's Appendix 1, plus new ones.

- **I-1/I-2.** Income = Σ amount where `kind = income`. Expenses = −Σ amount where `kind IN (expense, refund)`. Rows with `excluded` or `deleted_at` never count. Transfers, card payments, opening balances, adjustments and ignored rows never count.
- **I-3.** A confirmed `transfer` or `card_payment` link joins two legs in different accounts whose amounts sum to 0 (same currency). Manual transfers are created as two legs plus one link, in one database transaction.
- **I-8.** `original_description` is set once at insert and never updated: a SQLite trigger blocks it, and the Rails model makes it read-only. `description` is the editable display text. `merchant_key` is computed from `original_description`.
- **I-9.** Deleting an entry is a soft delete into the trash, with an audit event. Purging from the trash is explicit. Deleting a category moves its entries (to a chosen category or Uncategorized), with an audit event listing them.
- **I-10.** Only `income`, `expense` and `refund` carry a meaningful category. Transfer-like kinds use the built-in `Transfers` category name, kept for compatibility with older readers.
- **I-13 (owner).** A local file whose `owner_account_id` differs from the signed-in account never downloads, uploads, reports metadata or runs AI. It is not even listed for that account (per-account database lists).
- **I-15 (refund cap).** Σ `refund_of` link amounts for one expense ≤ |expense amount|.
- **I-16 (AI precedence).** Automation (rules, AI, re-import, recurring) never changes a field listed in `user_locked_fields`. AI changes are applied only after review (or by an explicitly enabled auto-rule), are grouped by `batch_id` in audit events, and can be undone as a group.
- **I-17 (backup).** A restore always goes into a new, empty database slot, never over an existing one. After a restore, row counts and amount checksums equal the backup manifest, or the restore is rolled back.

## 3. Physical schema: PostgreSQL (additive migrations)

```
users: + finance_owner_uid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE

finance_books (new)
  id, uuid UNIQUE, user_id FK NOT NULL, name(60), base_currency(3), book_type personal|business,
  month_start_day 1..28 default 1, archived_at, timestamps.  Unique (user_id) WHERE default_book.
  (Created lazily by Finance::Book.default_for(user); no backfill needed for existing tables in this phase.)

finance_bank_accounts: + account_type (financial-schema account_types; backfilled from kind via legacy_account_kinds.web),
  currency, opening_balance decimal(15,2) default 0, opening_balance_on, credit_limit decimal(15,2), statement_day, due_day,
  include_in_net_worth bool default true, note, sort_order int default 0, archived_at, book_id FK NULL, manual bool default false.
  identity_key and last4 become NULLable (manual accounts have neither); unique (user_id, identity_key) stays.

finance_transactions:
  statement_id -> NULL allowed (manual entries)
  + uuid (default gen_random_uuid()), kind (CHECK in kinds; backfill legacyKind), bank_account_id FK NULL (backfill from statement),
    original_description string(500) (backfill = description; read-only in the model), entry_origin (import|manual|upload|recurring|legacy),
    merchant_id, project_id, note text, occurred_at_time "HH:MM", deleted_at, category_source, category_confidence, category_model,
    user_locked_fields jsonb default [], recurring_rule_id, recurring_on, book_id NULL, fingerprint (indexed)
  CHECK (statement_id IS NOT NULL OR entry_origin IN ('manual','recurring'))
  scope included := excluded=false AND deleted_at IS NULL AND kind IN (income, expense, refund)

finance_transaction_links, finance_audit_events, finance_merchants, finance_projects, finance_tags, finance_transaction_tags,
finance_budgets, finance_recurring_rules, finance_category_settings, finance_organize_runs: same columns as §4, Rails types
(bigint ids, uuid, decimal(15,2) for money, jsonb for JSON, timestamptz), each with user_id NOT NULL and book_id NULL.
```

Every query is scoped by `current_user`. Every cross-row reference is also checked to belong to the same user, both in model validations and in services.

## 4. Physical schema: SQLite (migration `0007_ledger.sql`)

Migration `0007_ledger.sql` is purely additive: new tables, new nullable or defaulted columns, and trigger replacement. It runs after an automatic file snapshot taken by the Rust side (`snapshot.rs`).

- `accounts` (`uuid`, `name`, `account_type`, `currency`, `institution`, `last4`, `account_key UNIQUE` (link to imported statements), `opening_balance_cents`, `opening_balance_on`, `credit_limit_cents`, `statement_day`, `due_day`, `include_in_net_worth`, `note`, `sort_order`, `archived_at`, timestamps). It is backfilled from the distinct `statements.account_key` values, plus one "Imported (no account)" account for legacy and website rows.
- `statements` + `account_id`.
- `transactions` + `uuid`, `kind`, `account_id`, `original_description`, `entry_origin`, `merchant_id`, `project_id`, `note`, `occurred_at_time`, `deleted_at`, `user_locked_fields`, `category_confidence`, `category_model`, `recurring_rule_id`, `recurring_on`.
  - `kind` is backfilled with `legacyKind`, and `original_description` with `description`.
  - Triggers: `transactions_fill_identity` (uuid and original_description on every insert path) and `transactions_original_immutable`.
- `import_staging_rows` + `kind`, `account_id`, `original_description`. The `statements_commit_staged` trigger is recreated to copy them.
- `category_meta(name PK NOCASE, parent, category_kind, sort_order, hidden, updated_at)`.
- `merchants`, `projects`, `tags` (`uuid`, `name UNIQUE NOCASE`, `note`, `sort_order`, `archived_at`, timestamps), plus `transaction_tags`.
- `transaction_links(uuid, link_type, from_transaction_id, to_transaction_id, amount_cents, status, decided_by, created_at)`.
- `budgets(uuid, period, category, project_id, amount_cents > 0, alert_percent, timestamps)`.
- `recurring_rules(uuid, name, template JSON, frequency, interval, start_on, end_on, next_on, auto_post, paused, timestamps)`.
- `audit_events(uuid, at, actor, action, subject_type, subject_id, batch_id, summary, changes JSON, undo JSON)`. These are append-only: UPDATE and DELETE are blocked unless `settings.audit_purge = '1'`, which is set only by "Delete all data".
- `organize_runs(uuid, created_at, status, engine, proposals JSON, applied_at, undone_at, batch_id)`.

## 5. Shared semantics that both sides must produce identically

These are checked by the contract fixtures.

1. `inferKind` (import), `legacyKind` (backfill), `suspectIncome` (review list).
2. Duplicate detection: `detectDuplicates`, `dedupe-cases.json`.
3. Totals, balances and net worth: `fixtures/ledger/appendix2-scenario.json`.
4. Manual entry validation codes: `entryProblems`.
5. Recurrence dates (`nextOccurrence`, month-end clamping) and budget periods (custom month start).

## 6. Migration strategy (both sides)

**Backup → additive schema → backfill (reproduces current totals) → validate → switch reads/writes → verify → remove deprecated structures only when safe.**

- **Local:**
  - The Rust snapshot copies every slot file (`.db`, `-wal`, `-shm`) before a new migration runs. The last 2 copies per slot are kept.
  - A user-triggered backup file can be restored into a new slot, and is verified.
- **Web:**
  - Development and tests run only against a local PostgreSQL. `DATABASE_URL` is always set explicitly, because `.env.local` points at the Neon `production` branch.
  - Production migrations need a Neon branch first. They are **not run** as part of this work.
- **Not dropped:** `finance_custom_categories` and the text `category` column stay. `kind` becomes the source of truth for totals. The `Transfers` category name is kept only for compatibility.

## 7. Implemented ER diagram (logical; both platforms)

```mermaid
erDiagram
    users ||--o{ finance_books : "owns (default book; local: one file = one book)"
    users ||--|| owner_uid : "finance_owner_uid -> local settings.owner_account_id"
    finance_books ||--o{ accounts : contains
    accounts ||--o{ statements : "evidence for"
    statements ||--o{ transactions : "first evidence (local: hidden manual container for manual entries)"
    accounts ||--o{ transactions : "entries of (signed, account's view)"
    transactions ||--o{ transaction_links : "from (transfer / card_payment / refund_of / duplicate_of)"
    transactions |o--o{ transaction_links : to
    transactions }o--o| merchants : merchant
    transactions }o--o| projects : project
    transactions ||--o{ transaction_tags : tags
    tags ||--o{ transaction_tags : ""
    transactions }o--o| recurring_rules : "posted by (rule + date unique)"
    category_meta ||--o{ category_meta : "parent (2 levels)"
    budgets }o--o| projects : scope
    finance_books ||--o{ audit_events : "append-only log, undo data"
    finance_books ||--o{ organize_runs : "AI proposals / applied batch"
    transactions {
        string uuid
        string kind "explicit economic meaning"
        string original_description "immutable"
        string description "editable"
        string category "text name (tree in category_meta)"
        json user_locked_fields "automation never overrides"
        string entry_origin "import|manual|web_copy|recurring|..."
        datetime deleted_at "trash"
    }
```

## 8. The ten open decisions of review §K.2 — resolved defaults

Each entry: alternatives → default chosen (implemented unless noted) → Suishouji evidence → DB → UX → dependencies.

1. **Q1 Owner mismatch on a shared device.** Alternatives: separate list per account / prompt / block. **Default: separate list per account (implemented), plus a one-time "Is this yours?" prompt for every unowned database with content, including the legacy list. Upgrading an email-based binding to an immutable owner id also requires confirmation when the database has content.** Suishouji: books are server-side per user; no local multi-user problem. DB: `settings.owner_account_id` (`id:<uuid>` or `email:<sha256>` before servers send an id, upgraded after confirmation); `users.finance_owner_uid`. UX: bound databases open without a prompt; legacy ownership is never inferred from being first to sign in. Dependency: deploy the `owner_id` API field (migration `20261115000100`).
2. **Q2 Delete statement keeps user overrides?** Alternatives: archive and keep entries as manual / hard delete with warning. **Default: entries are soft-deleted to the trash (restorable); removing a whole import (reverse import) remains a deliberate hard delete with an audit event; links and tags go with the rows.** Suishouji: deleting an account or category deletes its transactions with no trash on web — the behaviour to avoid. DB: `deleted_at`, audit. UX: mistakes are recoverable. Dependency: none.
3. **Q3 Pending transactions.** **Default: keep skipping (unchanged).** Suishouji has no pending concept. The `pending_to_posted` link type is reserved. Dependency: cash-flow forecasting work.
4. **Q4 Zelle/Venmo default.** **Default: expense/income unless proven own-account (kept);** person-to-person words (Zelle, 微信转账) are not transfer patterns; "Organize" pairs real own-account transfers (opposite amounts ≤3 days, two of the person's accounts). Suishouji: 转账 always means between own accounts. Dependency: none.
5. **Q5 Refund presentation.** **Default: net within the category (implemented on both sides);** refunds link to the original and are capped. Suishouji: negative expense in the category, no link — same reporting effect, weaker integrity.
6. **Q6 One pipeline implementation.** **Default: (a) port rules to Ruby with parity fixtures (implemented):** the JSON manifest is read by both; `kind-cases.json`, `dedupe-cases.json`, `appendix2-scenario.json` are replayed in Vitest and Minitest.
7. **Q7 Local DB uploaded to web becomes?** **Default: a new web book** (not implemented: upload still targets the default book; `finance_books` exists). Dependency: multi-book web UI.
8. **Q8 Multi-currency.** **Default: one currency per book for now;** per-account `currency` column kept. Suishouji: 128 currencies, automatic FX to CNY, dual amounts on cross-currency transfers. Dependency: an FX rate source and `finance_exchange_rates` (P3).
9. **Q9 FinRx hosting.** **Default: separate deployment sharing `finance-core` + manifest** (unchanged recommendation). Suishouji's roles (owner/admin/member/observer, per-person-day pricing) inform the FinRx membership design.
10. **Q10 Audit privacy.** **Default: audit events store before/after values** (needed for undo and the trash); they are user-owned, never uploaded, purged by "Delete all data" / `DataDeletion`. Suishouji's operation log likewise records actor, time and change.
