# Typed commands (Natural Language Action Engine) in BillieWeather

This document covers three things: how the reusable engine was integrated into this repository,
what it can do here, how safe it is, and how accurate it measured. To use the engine in another
product, read [`packages/nl-action-engine/README.md`](../packages/nl-action-engine/README.md).

## 1. Architecture assessment

| Part | What it is | Relevant to commands |
|---|---|---|
| Rails app (`app/`, Bullet Train, PostgreSQL) | Website: auth, finance pages, API for the apps | Not changed. Its finance logic is mirrored in `packages/finance-core`. |
| `clients/universal` (React 19 + Tauri 2) | Local-first desktop/mobile app. All financial data lives in on-device SQLite through `FinanceStore` (`src/services/store.ts`). | **Integration point.** Offline, TypeScript, the business services are already one class, and data is isolated per account and per device database. |
| `packages/*` | Dependency-free TypeScript shared by the clients, resolved by path alias without a build step | The engine follows the same convention. |
| Existing command handling | None. Every action is a button or form on a page. | — |

Constraints found, and how they shaped the design:

- **No multi-statement transactions.** Tauri's SQL plugin pools connections, so `BEGIN`/`COMMIT`
  are not reliable, and the store already avoids them. Bulk changes record the exact previous
  state (`FinanceStore.transactionFlags`) and restore it on failure
  (`restoreTransactionFlags`): all-or-nothing by compensation. The same record powers Undo.
- **Isolation.** The tenant is `account email # database id`. Each account and database gets
  its own session, executor, idempotency store and undo store (`CommandCenter` rebuilds them
  when either changes). A plan made in one database is rejected in another (`scope_mismatch`).
- **Six interface languages.** Commands are understood in English and Chinese (Simplified and
  Traditional, also mixed). The bar's own text, the questions and the results are translated
  into all six interface languages (`src/i18n/command.ts`, checked by `test/i18n.test.ts`).

## 2. What was added

```
packages/nl-action-engine/      @nlae/core   headless engine, registry, dialogue, executor, JSON Schemas (no deps)
packages/nl-action-react/       @nlae/react  optional command bar UI (peer: react)
clients/universal/src/commands/ actions.ts   BillieWeather's Action Registry (all finance vocabulary lives here)
                                handlers.ts  trusted-side handlers over the existing FinanceStore
clients/universal/src/components/CommandCenter.tsx   wiring + translations; shown above every page
```

Changes to existing files are small and additive:

- `App.tsx` renders the bar and passes a command filter to Transactions.
- `Transactions.tsx` takes an optional `preset` filter, shown as a clearable chip.
- `store.ts` gets four new methods (`transactionFlags`, `restoreTransactionFlags`,
  `setCategoryMany`, `restoreRules`), with no schema change and no migration.
- `styles.css` maps `--nlae-*` to the design tokens.
- The i18n files get a `command` section.
- `tsconfig.json` and `vite.config.ts` get aliases, plus React de-duplication because the repo
  root has a second React copy.

### Actions

| Action | Example | Risk / confirmation | Undo |
|---|---|---|---|
| `app.navigate` | “open reports”, “去设置” | none | — |
| `transactions.find` | “show starbucks last month”, “查找超过100元的交易” | none (opens the filtered list) | — |
| `finance.spending` / `finance.income` | “how much did I spend on food last month”, “今年总收入” | none (answer only) | — |
| `transactions.categorize` | “move uber to transport”, “把星巴克改成餐饮” | medium: preview + confirm | exact restore |
| `transactions.exclude` / `include` | “exclude venmo”, “把 Venmo 重新计入” | medium: preview + confirm | exact restore |
| `categories.create` | “新建类别 宠物” | low: confirm | while unused |
| `categories.rename` | “rename category Pets to Pet care” | medium: confirm | rename back |
| `categories.delete` | “删除类别 宠物” | high: type the name | category + rows + rules restored |
| `app.language` / `app.theme` | “switch to dark mode”, “语言 繁体中文” | none (device preference) | — |

Totals use the dashboard's rule: excluded rows and Transfers never count. A bulk change is
limited to 500 transactions. Category changes made by command are recorded as the person's own
choice (`category_source = 'user'`) and do not create merchant rules.

## 3. Safety properties (each covered by a test)

- The parser never writes. Only `ActionExecutor` calls handlers.
- Every data change is previewed by the trusted side. The preview is fingerprinted, and a change
  in the data since the preview is refused (`stale_preview`).
- The confirmation level comes from the registry, so a tampered plan can't lower it. The typed
  phrase is recomputed from trusted labels.
- Ambiguous intents or entities, unresolved references and negated commands never produce a ready
  plan. Neither do narrative sentences: past-tense verbs don't count, and long free text or low
  coverage triggers an intent check.
- Authentication, account/database scope and object-level validation are enforced: arguments are
  checked against the tenant's own entity list.
- Repeated or concurrent submissions of one plan execute once. Failed runs are not remembered, so
  a retry can succeed.
- Bulk changes are all-or-nothing by compensation. Undo is one-shot, belongs to one tenant and
  expires after 10 minutes.
- Works offline. The engine source imports nothing outside its folder and uses no network API.

## 4. Tests and measured accuracy

Run from `clients/universal`: `npx vitest run ../../packages/nl-action-engine/test test/commands`
(79 tests). The full client suite is 549 tests, all passing on 2026-11-11.

| Suite | Tests | Covers |
|---|---|---|
| `packages/nl-action-engine/test/engine.test.ts` | 56 | Normalization and script, typos, homophones, dates, money, ambiguity, unsupported input and false positives, negation, multi-turn (answers, cancel, references, follow-up, expiry), edits, suggestions, executor (confirmation, typed phrase, idempotency incl. concurrent, stale preview, tenant/auth/object-level checks, tampering, malformed plans, failure and retry, undo scope and expiry), offline, no domain vocabulary, optional fallback. Runs on an invented task-manager domain to prove the core is domain-agnostic. |
| `packages/nl-action-engine/test/schema.test.ts` | 4 | Real plans, requests, results and the manifest conform to the JSON Schemas |
| `test/commands/billieCommands.test.ts` | 11 | Real actions on a real SQLite store: totals match the dashboard rule, find + filter, recategorize + exact undo, idempotency, **rollback when the 3rd write of a bulk change fails**, stale preview, create/rename/typed-delete + undo, refusals, database/account isolation, follow-up, preferences |
| `test/commands/commandBar.test.tsx` | 6 | UI in jsdom: direct answers, editable preview → confirm → undo, clarification → typed confirmation, unsupported input, keyboard suggestions, localized text |
| `test/commands/evaluation.test.ts` | 2 | Labeled corpora (below) |

### Evaluation corpus

`today` = 2026-11-11; custom categories “Pets” and “Coffee runs”. A case counts as correct only
if the intent, the status and every labeled argument match exactly.

| Set | Cases | Intent accuracy | Full accuracy | False positives (negatives) | Clarification cases |
|---|---|---|---|---|---|
| `corpus.json`, **first run, before tuning** | 125 (98 pos., 22 neg., 5 clarify) | 95.9% | 94.9% | **9.1% (2/22)** | 5/5 |
| `corpus.json` after fixes (it was used for tuning, so this is optimistic) | 125 | 100% | 100% | 0/22 | 5/5 |
| `heldout.json`, **written after tuning, first blind run** | 69 (56 pos., 12 neg., 1 clarify) | **98.2%** (55/56) | **94.6%** (53/56) | **0/12** | 1/1 |
| `heldout.json` after fixing the one real bug it found (“from last week” read as “since”) | 69 | 98.2% | 96.4% | 0/12 | 1/1 |

Held-out results by group (first run): English 32 cases, Simplified Chinese 16, Traditional
Chinese 4, mixed 4, typo 4, homophone 2, paraphrase 4. The non-English groups scored 100%, but
the samples are small. Parsing takes about 1–2 ms per command (p95) on the development Mac.

Remaining held-out failures:

- “list charges above $250 this month” is unsupported, because “list” without “transactions” is
  not an expression.
- “ignore zelle transfers” gives the search “zelle transfers”, where the label expected “zelle”.

Caveats:

- The same person wrote the grammar and both corpora, so real-world accuracy will be lower.
- The held-out set is small, and its Traditional Chinese, mixed and homophone samples have only
  2–4 cases each.
- No user data was collected.

## 5. Not done / limitations

- Commands work only in the universal client. The Rails website has no command bar. The protocol
  allows a Ruby trusted side (manifest + JSON Schemas), but one was not built.
- Japanese, Korean and Spanish commands are not parsed. The bar's interface text is translated
  into those languages.
- Idempotency and undo records are in memory: closing the app ends Undo.
- Category deletion through the store is still three statements, as before. If the app crashes in
  the middle, it can be left partly done, the same as the existing Categories page.
- The app was not driven in a real browser or Tauri window: signing in needs the Rails server. It
  was validated through jsdom UI tests and real-store integration tests.
- The vocabulary tables (pinyin, Traditional→Simplified, stopwords) are bounded. See the engine
  README for the dependency assessment and the plug-in points for pinyin-pro and opencc-js.
