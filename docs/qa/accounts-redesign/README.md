# Accounts & Assets redesign: acceptance record

2026-11-28 · developed directly on `main` (main-only policy) · synthetic data only

## Before and after

| Scene | Before | After |
| --- | --- | --- |
| Web, populated book (1440 px) | [before](before-populated-1440.png) | [after](after-populated-1440.png) · [dark](after-populated-1440-dark.png) · [简体中文](after-populated-1440-zh-CN.png) |
| Web, 120 accounts | [before](before-many-1440.png) | [after](after-many-1440.png) |
| Web, empty book | [before](before-empty-1440.png) | [after](after-empty-1440.png) |
| Web, phone (390 px) | | [after](after-populated-390.png) |
| Local client, browser SQLite | | [Chromium](sqlite-chromium-populated.png) · [WebKit](sqlite-webkit-populated.png) · phones: [Chromium](sqlite-chromium-phone.png), [WebKit](sqlite-webkit-phone.png) |

The "before" captures were taken from `main` at `93514e1`, before any change. The "after" captures use
the same synthetic users, plus two statement-imported accounts.

The "before" page added the EUR travel wallet into the USD Cash subtotal and net worth as $280.00.
The new page keeps EUR on its own and labels it "not converted".

## What changed

- **One table on both platforms.** A shared grouped table (`clients/universal/src/accounts`)
  replaces the per-type cards. The local client renders it directly. Rails renders the same component
  from the committed bundle `public/accounts-table.js`, built by
  `node clients/universal/scripts/build-overview.mjs`. Without JavaScript, Rails shows a plain
  fallback table.
- **Header.** Add account opens the existing AI capture panel, which also offers screenshot,
  statement and manual entry. The toolbar has search, filter, sort, hide balances, and a More menu
  with reorder mode, columns, density, empty categories and reset.
- **Summary strip.** Total assets, total liabilities, net worth and liquid assets for the book
  currency. These come from the dashboard's own `position()`, so the two pages agree. Other
  currencies get their own totals labeled "not converted". Unknown balances are counted and named,
  never treated as 0. Fixed assets are named as a separate module.
- **Grouped table.** Liquid assets, financial assets, liabilities and other accounts, with a
  subgroup per account type when a group has several. Groups collapse, and subtotals line up under
  the balance column. Rows are 40 px (compact) or 48 px (comfortable) and open the account when
  clicked. Each row has a "…" menu with: view details, edit, transactions, add transaction, update
  balance, review statement difference, import statement, change type, reorder, archive or restore,
  and delete (only when unused).
- **Keyboard and reordering.** Arrow keys move between rows, Enter opens a row, and Shift+F10 or
  the context-menu key opens its menu. Reorder mode supports drag-and-drop, arrow buttons and
  Alt+arrow. Rails saves the order with `PATCH /app/accounts/reorder`, which refuses ids that are
  not the person's.
- **Confirmations.** Archive and delete ask in the page. Browser dialogs are not allowed in the
  apps.
- **Phone layout.** A compact list showing name, institution, masked number, date and balance,
  without horizontal scrolling.
- **Accounting rules.** These are written down in
  [finance-domain-spec §5.6](../../architecture/finance-domain-spec.md). Archiving now only hides an
  account. On both platforms, net worth counts every account marked "include in net worth".

## Data and compatibility

- **No schema change.** There are no PostgreSQL or SQLite migrations, and no record is rewritten.
  New reads only:
  - `Finance::AccountTableData`, plus `OverviewData#balances`, which `position` already used
    internally.
  - `accountEvidence()` in the local client: the latest entry date, the latest adjustment date, and
    whether the latest statement matches.
- **The one new write.** Reordering, which saves only `sort_order`, exactly like the existing move
  buttons.
- **Preferences.** Saved in `localStorage`, versioned, validated on read, per signed-in owner and
  per device.

## Tests

| Area | Result |
| --- | --- |
| Shared model (`test/accountTable.test.ts`) | 14 passed |
| New Rails tests (`finance_accounts_table_test.rb`) | 5 tests, 24 assertions passed |
| Rails finance regression: finance integration, models, services, controllers | 630 tests, 29,147 assertions, 0 failures, 1 skip already present |
| Rails accounts, dashboard and localization re-run on the final code | 53 tests, 24,872 assertions, 0 failures |
| SQLite smoke, `scripts/accounts-smoke.mjs`, in headless Chromium and WebKit | Passed in both engines. It covers: creating the brief's example (Chase •••• 4821, $5,200; American Express, $830 owed) through review and confirmation; manual creation; groups; totals; search; filters; sort; hidden balances; hidden columns; collapsed groups surviving a reload; updating a balance; archiving with the in-page confirmation; and keyboard opening |
| Universal client suite, TypeScript plus Vitest with the Chrome channel | 101 files, 1,307 tests passed. The real Apple Vision OCR test was left out: it already times out after 25 seconds, unrelated to this work |

## Reproduce

```sh
# Rails preview on a scratch database (loopback only)
RAILS_ENV=test DATABASE_URL=postgres:///accounts_preview_test bin/rails db:create db:schema:load
RAILS_ENV=test DATABASE_URL=postgres:///accounts_preview_test ACCOUNTS_TEST_PASSWORD=… bin/rails runner docs/qa/accounts-redesign/seed.rb
RAILS_ENV=test DATABASE_URL=postgres:///accounts_preview_test bin/rails server -b 127.0.0.1 -p 18480
ACCOUNTS_TEST_PASSWORD=… node docs/qa/accounts-redesign/capture-web.mjs
# Local client (browser SQLite in memory)
cd clients/universal && npx vite --port 18482 --strictPort --host 127.0.0.1 &
node scripts/accounts-smoke.mjs; ACCOUNTS_WEBKIT=1 node scripts/accounts-smoke.mjs
```

Afterwards, drop `accounts_preview_test` and stop both servers.

## Known limits

- **Account subtypes.** Term deposits, retirement, mortgages, and auto and personal loans are not
  account types yet. Adding them needs an additive `account_type` change on both platforms, so they
  are grouped as the nearest existing type for now (savings, investment, loan).
- **Custom categories.** There are no user-defined account categories. The tree renderer has no
  depth limit, so they can be added later.
- **No conversion or sync.** There are no exchange rates, so other currencies are never converted.
  There is no bank sync, so no "Synced" status exists.
- **Add transaction.** On the local client, Add transaction opens the transactions page filtered to
  the account, with a new expense form. The form does not preselect the account, because entry
  drafts do not carry one yet.
- **Liquid assets.** These follow the dashboard rule: active liquid accounts, including ones left out
  of net worth.
- **Native window not tested.** Only the browser runtime of the local client was exercised; no
  native app window was opened.
