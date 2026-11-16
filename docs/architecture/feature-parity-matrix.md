# Feature Parity Matrix: Suishouji (随手记) → BillieWeather / FinRx

**Date:** 2026-11-15
**Sources:**
- Hands-on research: `docs/research/suishouji-hands-on-inventory.md`, with 58 screenshots in `docs/research/suishouji-screenshots/`. All testing was done in the synthetic book `BW合成测试-勿用`; the account owner's four real books were never opened.
- BillieWeather code in this working tree (uncommitted).

**Statuses:**
- Verified in Suishouji
- Partially verified
- Not accessible
- Not present on web (exists only in the Suishouji app, or nowhere)
- Already implemented
- Implemented and tested
- Implementation in progress
- Blocked
- Not applicable (with a justification)

"Tested" means automated tests, plus a real UI walkthrough where one is noted.
- **Web:** Rails integration tests, plus a browser walkthrough on a synthetic local database.
- **Local:** Vitest store tests plus jsdom UI tests (`manualBookkeeping.test.tsx`, `ownerBinding.test.tsx`). Native Tauri builds were not launched.

## Books and organisation

| Suishouji feature | Chinese UI label | Observed behavior | BillieWeather Web | Local app | Required changes (done) | Status | AI enhancement |
|---|---|---|---|---|---|---|---|
| Create / rename book | 新建账本 / 账本设置 | Created from a template; name ≤16 chars | One default `finance_books` row per user, created lazily. There is no UI for multiple web books yet. | One SQLite file = one book (`settings.book_uuid`); create and rename on the Data page (already existed) | `finance_books` table; `book_uuid` setting | Local: already implemented. Web: data model only. | — |
| Delete book with 7-day restore | 删除账本 | Restore only in the mobile app | "Delete my financial data" (already existed) | Delete database (typed confirmation) plus **backup file / automatic snapshot restore** | Backup and restore (P0-5) | Implemented and tested (local) | — |
| Base currency per book | 本位币 | Not on web | Single currency per user (existing) | Per book; chosen on the Accounts page for a manual-only book | `setBookCurrency` | Implemented and tested | — |
| Custom month start | 自定义月起始日 | Not on web | — | `month_start_day`; budgets use it | `periodBounds(…, monthStartDay)` | Implemented and tested (local) | — |
| Members, roles, permissions | 成员管理 / 角色管理 | 4 built-in roles plus custom; paid per person per day | — | — | — | Not applicable now: BillieWeather is single-owner. Planned as a FinRx extension on Bullet Train teams and memberships (review Q9). | — |
| Operation log | 操作日志 | Only a permission checkbox on web | `finance_audit_events` plus an Activity page | `audit_events` (append-only via triggers) plus the Activity log on the Data page | New tables; every write is audited | Implemented and tested | AI batches show as one undoable group |
| Trash | 流水回收站 | **None on web**; deletes are immediate | Trash page: restore and purge | Trash view: restore, delete for good, empty trash | `deleted_at` soft delete | Implemented and tested (web browser check: page loads) | — |
| Period lock / year-end carry-over / transfer ownership | 封账 / 结转 / 转让 | Not on web | — | — | — | Not applicable (deferred): BillieWeather keeps continuous history (review §C.4). Period lock is a FinRx candidate after tax filing. | — |

## Accounts

| Suishouji feature | Chinese label | Observed behavior | Web | Local | Changes | Status | AI |
|---|---|---|---|---|---|---|---|
| Account CRUD, 7 types | 账户管理 | Same fields for every type; currency; hidden; counts in assets | `/app/accounts`: 9 types, create, edit, archive, reorder; delete only when unused | Accounts page: same | `finance_bank_accounts` extended; local `accounts` table | Implemented and tested (web: browser walkthrough) | — |
| Opening balance | 期初余额 | Creates a delta entry | Opening balance field | Field; for imported accounts it is derived from the latest statement closing balance (marked "estimated") | Migration 0007 backfill | Implemented and tested | — |
| Set balance / balance adjustment | 余额 / 余额变更 | Creates a 余额变更 entry | "Adjust balance" creates a `kind=adjustment` entry | Same | `adjustBalance` | Implemented and tested | — |
| Credit card limit, statement day, due day | — | **Not on web form** | Fields | Fields; shows available credit | New columns | Implemented and tested (BillieWeather goes further than Suishouji) | — |
| Hide account / exclude from net worth | 隐藏 / 计入资产 | Hidden accounts still count in reports | Archive, plus "Include in net worth" | Same | `archived_at`, `include_in_net_worth` | Implemented and tested | — |
| Delete account | 删除账户 | **Deletes all its transactions**, including transfer legs, so other balances change | Refused when the account has entries; archive instead | Same | Invariant I-9 | Implemented and tested. **Deliberate deviation:** no silent loss of history. | — |
| Assets / liabilities / net worth | 净资产 | Account report | Accounts page totals; net worth report | Accounts page totals; monthly net-worth history in Reports | `netWorth`, `netWorthHistory` | Implemented and tested | — |
| Multi-currency accounts | 币种 | 128 currencies; automatic FX to CNY | Single currency (existing) | Single currency per book | — | Not implemented (review Q8): needs an FX data source. The model keeps a per-account `currency` column. | — |
| Reconciliation | 对账 | Not on web | Statement reconciliation (existing local pipeline) | Same | — | Partially implemented: per-statement only; no per-account running-balance screen yet | AI "help reconcile": future |

## Transactions

| Suishouji feature | Chinese label | Observed behavior | Web | Local | Changes | Status | AI |
|---|---|---|---|---|---|---|---|
| Expense / income | 记一笔 支出 / 收入 | Amount, category, account, time, member, merchant, project, note, images | `/app/entries/new`: kind tabs, time, merchant, project, tags, note, description | EntryForm (same fields) | Explicit `kind`; manual entries without a statement | Implemented and tested (web browser walkthrough; local jsdom walkthrough) | AI suggests categories |
| Transfer | 转账 | **One record** with from and to | Two linked legs (`finance_transaction_links`) | Two legs plus a link, written in **one SQL statement** via a trigger | `transaction_links` | Implemented and tested. Deviation: paired legs fit import (review §H, option C). | AI pairs imported transfers |
| Credit-card repayment | 转账 → 信用卡 | Transfer that lowers the liability | A transfer into a liability account becomes `card_payment` | Same | `transferKind` | Implemented and tested (web: card balance −80 + 30 + 50 = 0) | AI pairs payment legs |
| Refund | 退款 | Negative expense, `#退款#` note, **no link** | Refund tab: choose the original purchase; partial refunds; over-refund refused | Same; the cap is enforced by a DB trigger | `refund_of` link | Implemented and tested (web: refunding $90 against $80 is refused). **Better than Suishouji.** | AI matches refunds to purchases |
| Loan / lend / pay-for / reimburse | 借贷 / 代付 / 报销 | No web entry tabs | Liability and receivable accounts plus transfers | Same | `receivable` and `loan` types | Partially implemented: no loan centre or contacts (FinRx counterparties) | — |
| Edit / copy / delete | 编辑 / 复制 / 删除 | Type locked on edit; delete is immediate | Edit (original bank text kept), soft delete, restore | Edit, copy, soft delete, restore, purge | `original_description` immutable (trigger and `attr_readonly`) | Implemented and tested | — |
| Batch edit / delete | 批量编辑 | Batch delete works; batch modify unconfirmed | Batch category, project, tags, delete | Batch category, merchant, project, tag, trash | `batchUpdate` | Implemented and tested | — |
| Multi-entry grid | 记多笔 | Paid (Basic) | — | — | — | Not implemented ("save and add another" exists on web) | — |
| Search / filter | 筛选 | 15 types, amount range, dimensions | Kind, account, merchant, project, tag filters | Same, plus the command bar | — | Implemented and tested | — |
| Attachments / images | 图片 | Up to 9 | — | — | — | Not implemented (privacy and storage design needed) | — |
| Time of day | 时间 | Stored to the second | `occurred_at_time` (HH:MM) | Same | Column | Implemented and tested | — |

## Categories and dimensions

| Suishouji feature | Chinese label | Observed behavior | Web | Local | Changes | Status | AI |
|---|---|---|---|---|---|---|---|
| Two-level categories, income and expense | 收支分类 一级 / 二级 | Re-parent level 2, hide level 2 | `finance_category_settings`; tree, arrange, hide | `category_meta`; CategoryTree: parent, tree, hide, reorder | New tables; custom limit 50 → 200 | Implemented and tested | — |
| Delete category | 删除分类 | **Deletes all its transactions** | Moves entries to a chosen category | Same, plus merge | — | Implemented and tested. **Deliberate deviation:** no data loss. | — |
| Merchants | 商家管理 | Creating one is paid (Pro) | `/app/lists/merchants`: create, rename, merge, archive, delete | Lists page: same | `merchants` tables | Implemented and tested (free) | AI normalises merchant names |
| Projects | 项目管理 | Choosing a parent is paid | Same as merchants | Same | `projects` | Implemented and tested | — |
| Tags | — | Not a separate object in Suishouji | Tags | Tags | `tags` and `transaction_tags` | Implemented and tested (BillieWeather addition) | — |
| Members as a dimension | 成员 | Virtual members | — | — | — | Not applicable now (single owner; household members are a FinRx/P3 item) | — |
| Classification rules | — | — | Merchant rules (existing) plus locked fields | Same | `user_locked_fields` | Implemented and tested | AI never overrides locked fields |

## Planning and reports

| Suishouji feature | Chinese label | Observed behavior | Web | Local | Changes | Status | AI |
|---|---|---|---|---|---|---|---|
| Budgets | 预算 | Web: only a home widget | `/app/budgets` | Budgets & schedules: monthly or yearly; total, category or project; 90% warning | `budgets` | Implemented and tested | — |
| Recurring entries | 周期记账 | Not on web | `/app/recurring` with "Post due" | Schedules: preview dates, post due (idempotent), skip, pause, optional auto-post when the app opens | `recurring_rules` | Implemented and tested | AI detects recurring payments (shown as suggestions) |
| Reports | 报表 / 报表库 | 6 tabs plus a library | Ledger reports by dimension (existing Report retained) | Group by category, account, merchant, project, tag or month; net worth over time | `report`, `netWorthHistory` | Implemented and tested | — |
| Export | 数据导出 | Paid (Basic) | CSV and Excel (existing) | CSV and Excel (existing) | — | Already implemented (free) | — |
| Import | 数据导入 | CSV/xls, ≤2 MB | Statement import (existing) plus **cross-file duplicate detection** | Universal import (existing); **null-account wildcard fixed** | `DuplicateDetector`; R9 fix | Implemented and tested | AI import, privacy-limited: existing |
| Duplicate detection / merge | 重复流水 (beta) | — | Review list "Possible duplicates" | Organize panel proposes duplicates; `markDuplicate` | `duplicate_of` link | Implemented and tested | AI proposes duplicates |

## BillieWeather-specific (not in Suishouji)

| Feature | Status |
|---|---|
| P0-1: owner binding of local databases, one database list per account, "Is this yours?" prompt | Implemented and tested (local unit plus jsdom; server `owner_id`) |
| P0-2: income by explicit kind; "Income to check" review list | Implemented and tested (web and local) |
| P0-3: cross-file duplicate detection on the web | Implemented and tested |
| P0-4: immutable original bank description | Implemented and tested (web model and local trigger) |
| P0-5: backup file (optionally encrypted) plus verified restore into a new slot; automatic pre-migration snapshots (Rust) | Implemented and tested locally (Rust unit tests; sql.js round trip). The web relies on Neon branches (not run). |
| "Organize my finances with AI": analyze, preview, approve, apply, undo | Implemented and tested locally. Web: `finance_organize_runs` table and batch undo in the activity log only; **no web analysis UI yet**. |
