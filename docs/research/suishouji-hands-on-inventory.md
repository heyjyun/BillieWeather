# Suishouji (随手记) Web: Hands-on Inventory of Manual Bookkeeping Features

## 1. Method and session notes

- **Date:** 2026-11-15, browser local time about 20:55–21:45. The server treats "today" as 2026-11-16, which suggests it uses China time (UTC+8). See §5.
- **Surface:** the web app at `https://www.feidee.com/cloud/#/`, driven through the chrome-devtools MCP while signed in to the user's account. I read labels from the a11y tree and DOM text. I did not use the mobile apps.
- **Synthetic book:** **`BW合成测试-勿用`**, made from the free official template **日常账本** (Daily book), Book ID `1208004336703823872`. It is still in place. All data in it is synthetic: accounts 测试账户A/现金B/信用卡C/应收D/美元F/隐藏G, categories 测试支出父改/测试支出子, and so on.
- **Second throwaway book:** `BW合成测试-删除`, created only to test book deletion, and deleted. The web app says it can be restored within 7 days, but only from the mobile app (随手记App → 我的 → 账本回收站). I did not test the restore.
- **Real books:** I never opened or touched "past（1）", "past（2）", "Dark time Mum" or "lulu life". On the book list only my two synthetic books had a "⋯" (delete) menu. The other four are older non-"神象云账本" books. Screenshots `01` and `53` show the book list with the real books' names and covers, but none of their contents.
- **Web book type:** books made on web are tagged **神象云账本** (Shenxiang cloud book). Membership pages say several features apply only to this book type: projects, merchants, accounts, loans, robots, and web batch entry.
- **Paywalls seen (I bought nothing):**
  - 基础会员 (Basic): 24 months ¥168 / 12 months ¥98 / 3 months ¥32 / 1 month ¥12 (Double-11 sale prices). Up to 20 books, 5 members per book.
  - 专业会员 (Pro): 24 months ¥498 / 12 months ¥288 / 1 month ¥30. Includes merchants, projects and role permissions.
  - Roles 成员 and 观察员 cost **1贝/人/天** (1 banana coin per person per day).
- **Not present on the web UI** (I looked at the sidebar, Settings, the avatar link, the transaction drawer, Reports and home customisation):
  - Budgets (预算). The only trace is a home widget, "本月预算及执行情况".
  - Recurring or scheduled entries (周期记账).
  - Reminders.
  - Loan centre (借贷中心) and the 借贷 / 代付 / 报销 entry tabs.
  - Book-level trash (回收站) and transaction trash.
  - Operation log (操作日志). It exists only as a permission checkbox.
  - Period lock (封账), carry-over (结转), transfer of ownership, book base currency, month start day.
  - Reconciliation (对账), account reorder, category reorder.
  - Tags as a separate object. A `#…#` hashtag convention appears in notes.
- **Blocked by policy:** two read-only DOM queries were refused by the harness. Neither was needed for the findings.
- **Automation caveats:**
  - Some Vue inputs, such as the account "余额" calculator input, ignore programmatic value setting. Only real keystrokes change them.
  - Several list pages do not refresh after a save until you reload the page.
  - My first refund attempt saved as an ordinary expense because the tab switch had not happened yet. I deleted it and redid the refund through real clicks.

## 2. Glossary (Chinese UI → English)

| 中文 | English |
|---|---|
| 账本 / 我的账本 / 新建账本 / 账本模板 | Book / My books / New book / Book templates |
| 神象云账本 | "Shenxiang cloud book" (web-native book type) |
| 账本设置 / 成员与角色管理 | Book settings / Members & roles |
| 数据导入 / 数据导出 / 导入记录 | Data import / export / import history |
| 记一笔 / 记多笔 | Add one entry / Add multiple entries (grid) |
| 流水 / 流水列表 / 流水类型 | Transactions / list / transaction type |
| 支出 / 收入 / 转账 / 余额 / 退款 | Expense / Income / Transfer / Balance (set balance) / Refund |
| 余额变更 / 负债变更 / 债权变更 | Balance change (asset) / Liability change / Receivable change |
| 借入 / 借出 / 收债 / 还债 / 代付 / 报销 / 坏账 / 免债 | Borrow / Lend / Collect debt / Repay debt / Pay on behalf / Reimburse / Bad debt / Debt forgiven (filter-only types) |
| 金额 / 分类 / 账户 / 转出账户 / 转入账户 | Amount / Category / Account / From account / To account |
| 记账时间 / 成员 / 商家 / 项目 / 备注 / 图片 / 记账人 | Date-time / Member / Merchant / Project / Note / Images / Recorded by |
| 收支分类 / 一级分类 / 二级分类 / 所属一级分类 | Income/expense categories / Level-1 / Level-2 / Parent category |
| 账户管理 / 账户类型 / 计入资产 / 隐藏 | Account management / Account type / Count in assets / Hidden |
| 现金账户 / 储蓄账户 / 信用账户 / 虚拟账户 / 投资账户 / 债权账户 / 负债账户 | Cash / Savings (debit) / Credit / Virtual (wallet) / Investment / Receivable / Liability |
| 净资产 / 总资产 / 总负债 | Net worth / Total assets / Total liabilities |
| 币种 / 折算 | Currency / Converted (FX) |
| 成员管理 / 待邀请 / 已加入账本 / 账本主人 | Members / Pending invite (placeholder member) / Joined / Book owner |
| 角色管理 / 管理员 / 顾问 / 成员 / 观察员 / 权限设置 | Roles / Admin / Advisor / Member / Observer / Permission settings |
| 商家管理 / 项目管理 / 项目分类 | Merchants / Projects / Project category (parent) |
| 显示已隐藏的… | Show hidden … |
| 批量编辑 / 批量修改 / 批量删除 | Batch edit mode / Batch modify / Batch delete |
| 编辑 / 复制 / 删除 / 查看流水 / 详情 | Edit / Copy / Delete / View transactions / Details |
| 筛选 / 搜索 / 汇总 | Filter / Search / Group-by summary |
| 报表 / 基础统计 / 报表库 / 推荐报表 / 我的报表 / 月报 | Reports / Basic stats / Report library / Recommended / My reports / Monthly report |
| 生成图片 | Generate image (share) |
| 自定义首页 | Customise home page |
| 基础会员 / 专业会员 / 香蕉贝 (贝) | Basic member / Pro member / "banana coins" |
| 保存成功 / 删除成功 / 名称不能为空 / 请输入必填项 | Saved / Deleted / Name cannot be empty / Fill required fields |

## 3. Feature inventory

### 3.1 Book creation (新建账本 / 账本模板)

- **Location:** top nav 我的账本 → "新建账本" card, which goes to 账本模板 (`#/market`).
- **Template market:** tabs 家庭 (Family), 个人 (Personal), 生意 (Business), 爱好 (Hobby). Each card shows a name, a badge (官方推荐 / 精选 / 热门 / 特色账本), a description, tags, a user count and an "添加" button.
  - Family-tab templates include: 家庭账本, 日常账本, 攒钱账本, 消费家庭账本, 储蓄家庭账本, 资产负债账本, 宝宝账本, 旅游账本, 儿童教育账本, 结婚账本, 我的负债账本, 夫妻理财账本, 回家账本, 投资家庭账本, 家庭装修账本, and others (about 30).
- **Flow:** clicking 添加 **creates the book immediately**. There is no form: no name, cover or currency field. The book takes the template's name, and a duplicate name gets a numeric suffix (the second one became "日常账本1"). The app then opens the new book (`#/book`).
- **Template seeds:**
  - Expense categories (9 level-1, 3–5 level-2 each).
  - Income categories (2 level-1).
  - Accounts: 现金(hidden), 工资卡, 储蓄卡, 余额宝, 微信余额, 信用卡.
  - Members: 老公, 老婆, 父母, 家庭公用.
  - Merchants: 便利店, 公交, 商场, 超市.
  - Projects: 所有 › 家庭, 个人, 工作, 旅游, 聚会聚餐.
- **Screenshots:** `01-book-template-market`, `02-new-book-home`.
- **Tested?** Yes, created (twice).

### 3.2 Book settings (账本设置)

- **Location:** sidebar 设置 (`#/book/setting/index`).
- **Content:** a book card with cover, name (inline edit pencil), 创建时间, 账本模板, 模板ID and 账本ID, plus three tiles: 成员与角色管理, 数据导入, 数据导出.
- **Rename:** inline text input, maxlength **16**. Saves on Enter or blur. An empty name is silently rejected and the old name stays (verified by reload). I renamed both books.
- **Missing from web settings:** cover change (no control seen), base currency, month start day, period lock (封账), carry-over (结转), transfer ownership, operation log, trash. None of these exist anywhere in the web UI.
- **Screenshot:** `03-book-settings-renamed`.
- **Tested?** Rename: yes.

### 3.3 Book delete (删除账本)

- **Location:** 我的账本 → hover a book card → "⋯" → 删除账本. Only web-native books I own show this menu.
- **Confirm dialog:** "删除神象云账本 — 是否确认删除《name》，删除7天内可通过随手记App_我的_账本回收站恢复". It shows the transaction count, 香蕉贝 balance, member count and days used, with buttons 取消 / 确认删除.
- **Result:** toast "账本删除成功"; the book disappears from the list. Restore is **not available on web** (app only).
- **Screenshots:** `53-book-delete-menu`, `54-book-delete-confirm`.
- **Tested?** Delete: yes, on `BW合成测试-删除`. Restore: not accessible on web.

### 3.4 Members (成员管理) — book users and "pending" members are one entity

- **Location:** sidebar 分类标签 → 成员管理 (`#/book/user`). The avatar link also goes here.
- **List:** columns 成员 / 备注 / 角色 / 结余 (balance = income − expense tagged to the member) / 操作 (详情, 邀请好友, 查看流水). Rows are split into **已加入账本** (real users; the owner has role 账本主人) and **待邀请** (placeholder members that can later be linked to an invited user). There is a "显示已隐藏的成员" checkbox.
- **Create:** 邀请 ▾ → 新建待邀请成员. A drawer "新建成员" opens:

| zh | en | type | req | options/default | validation |
|---|---|---|---|---|---|
| 图标 | Icon | icon picker | (has default) | small icon set | – |
| 名称 | Name | text, max 16 | yes | – | empty → toast "名称不能为空" |

- **Edit (详情):** same fields plus **隐藏** (Hidden) 是/否 radio, and a **删除** button.
- **Delete:** confirm "删除成员后，成员关联的账单同时也被解除关系，您确定要删除所选成员吗？". Verified: the transactions remain, and their 成员 field becomes "-".
- **Invite real users:** "邀请" / "邀请好友". **Not tested** (policy).
- **In the transaction form:** the member picker is a two-level cascader: 所有 / 最近使用 › member. Default: "所有 / iamlu", later "最近使用 / <last used>".
- **Screenshots:** `04-book-members-list`, `09-member-create`, `10-member-detail-edit`, `11-member-show-hidden`.
- **Tested?** Created, renamed, hidden, unhidden, deleted.

### 3.5 Roles and permissions (角色管理 / 权限设置)

- **Location:** 成员管理 → 角色管理 (`#/book/role`).
- **Built-in roles:**

| Role | Price | Description (zh → en) |
|---|---|---|
| 管理员 | free | Same maximum rights as the owner, except deleting the book |
| 顾问 | free | Cannot view transactions; can only maintain base data and roles |
| 成员 | 1贝/人/天 | Can add entries; can edit or delete only their own |
| 观察员 | 1贝/人/天 | Can view all entries; cannot do anything else |

- **Create role:** 创建角色 opens a drawer with 名称 (max 8) and 权限说明 (max 20).
  - **Bug:** an empty name was accepted and created a nameless role.
  - After saving, a prompt asks "是否立即为新角色“”设置权限？". Confirming opens `#/book/permission/<roleId>`. Custom roles are priced 1贝/人/天.
- **Permission matrix:** checkboxes, auto-saved with a "保存成功" toast on each change:
  - **记账 (bookkeeping):**
    - 新增 (add): scope "可使用全部基础资料 / 自定义基础资料使用范围" (all base data / custom scope)
    - 修改 (edit): "可以修改全部流水 / 仅修改自己创建的流水 / 自定义修改流水范围" (all / own only / custom)
    - 删除 (delete): same three options
    - 查看 (view): same three options
  - **基础资料 (base data):** 账户, 分类, 项目, 商家, 成员 (one checkbox each)
  - **操作日志 (operation log):** one checkbox. No log viewer exists on web.
  - **敏感数据 (sensitive data):** 允许查看账户余额 (may view account balances), 允许查看资产/负债 (may view assets/liabilities)
- **Edit / delete role:** 详情 drawer → 保存 / 删除. Delete confirm: "确认删除角色“X”吗？". Built-in roles open read-only.
- **Screenshots:** `05-book-roles-list`, `06-role-detail-admin`, `07-role-create`, `08-role-permission-matrix`.
- **Tested?** Created, renamed, toggled permissions, deleted.

### 3.6 Accounts (账户管理)

- **Location:** sidebar → 账户管理 (`#/book/finance/account`).
- **Header:** 净资产 / 总资产 / 总负债.
- **Tabs:** 资产账户 (asset accounts) / 负债账户 (liability accounts), plus a "显示已隐藏的账户" checkbox.
- **Table:** 账户名称 / 资产 (or 负债) / 币种 / 计入资产 / 备注 / 操作 (编辑, 删除, 查看流水). Accounts are grouped under their type: a group row with a subtotal, then child rows.
- **Create (新建账户 → drawer "新增账户").** Every type shows identical fields; there are no credit-card-specific fields.

| zh | en | type | req | options / default | validation observed |
|---|---|---|---|---|---|
| 账户类型 | Account type | dropdown | yes | 现金账户 (cash, emergency fund); 储蓄账户 (bank debit card, passbook); 信用账户 (credit card, JD 白条, 花呗 – accounts with credit limit); 虚拟账户 (WeChat/Alipay balance, canteen card, transit card); 投资账户 (funds, stocks, wealth products); 债权账户 (receivables); 负债账户 (payables) | "请选择账户类型" |
| 账户名称 | Name | text, max 20 | yes | – | "请输入账户名称" |
| 图标 | Icon | picker (~224 icons) | yes | none | "请选择图标" |
| 币种 | Currency | searchable dropdown | yes | 人民币 (usually prefilled); 128 currencies, e.g. 阿联酋迪拉姆 AED … 美元 USD | – |
| 余额 | Balance | numeric calculator-style input, maxlength 15 | yes | – | letters stripped; **negative allowed**; truncated to **2 decimals** (‑12.345 → ‑12.34) |
| 计入资产 | Count in net worth | radio 是/否 | – | 是 | – |
| 隐藏 | Hidden | radio 是/否 | – | 否 | (on create my "是" did not persist; set it later via edit) |
| 备注 | Note | text, max 50 | no | – | – |

- **Missing per type:** no statement day, repayment day, credit limit, sub-accounts, investment holdings or interest fields on web.
- **Edit ("编辑账户"):** same fields minus 账户类型. **The type cannot be changed.** Name, icon, currency, balance, flags and note are editable.
- **Balance changes create adjustment transactions** (verified):
  - Creating an asset account with 1,000 creates a "**余额变更** 1,000.00" entry. A liability account gets "**负债变更**". A zero opening balance creates no entry.
  - Editing a credit account balance from ‑12.34 to 100 created "负债变更 112.34", i.e. the **delta**.
  - These entries do not count in 收入/支出 totals. They show in lists with Edit / Copy / Delete actions.
- **Liability sign convention:** a positive balance on a liability account means you owe that amount. Total liabilities are added and net worth falls by it.
  - At creation I entered ‑12.34 on a credit account. That displayed 总负债 ‑12.34 and **raised** net worth to +12.34 (overpaid card).
- **Multi-currency:**
  - A USD account with 10 shows "10.00 USD 折算 CNY 66.71" (rate ≈ 6.671, automatic).
  - Group and book totals are in CNY.
  - There is no manual exchange-rate screen on web.
- **Hidden accounts:**
  - Removed from the account list unless "显示已隐藏" is ticked.
  - Removed from every transaction-form account picker.
  - Their existing transactions still appear in 流水.
- **计入资产=否:** the account's balance is excluded from group subtotals, 总资产, the asset donut and net worth. Verified with 测试隐藏G, balance 50.
- **Delete:** confirm "删除账户组后，也会删除账户和流水，确定删除吗？" (deleting the account also deletes its transactions). Verified: deleting 测试负债E also deleted both transfers with 测试账户A, so A's balance fell from 992.73 to 792.73. Counterpart balances change.
- **Reorder:** none (no drag handles). **Reconciliation (对账):** not present.
- **Per-account view:** 查看流水 opens 流水 filtered by account (`#/book/transaction?from=account…`), with 结余/收入/支出 for that account.
- **Screenshots:** `12-accounts-asset-tab`, `13-account-create-form`, `14-account-type-dropdown`, `15-account-icon-picker`, `16-account-credit-negative-balance`, `17-account-edit-form`, `18-account-balance-change-entries`, `19-account-currency-dropdown`, `20-accounts-after-create-usd-fx`, `39-account-A-transactions`, `56-account-delete-confirm`.
- **Tested?**
  - Created: cash, savings (CNY and USD), credit, receivable, liability, virtual.
  - **Investment account: opened only.** The form is identical to the others.
  - Edited, hidden, deleted.

### 3.7 Categories (收支分类)

- **Location:** sidebar → 收支分类 (`#/book/finance/category`).
- **Tabs and list:** 支出类型 / 收入类型 tabs and a "显示已隐藏的分类" checkbox. Columns: 分类名称 / 支出 (or 收入) total / 操作. Level-1 rows show 编辑 and 删除. Level-2 rows also show 查看流水.
- **Structure:** exactly **two levels**. Transactions attach to level-2 categories only: the picker requires a leaf and reports list level-2.
- **Create (新增分类):**

| zh | en | type | req | options/default |
|---|---|---|---|---|
| 分类类型 | Type | radio 支出分类/收入分类 | yes | defaults to the current tab |
| 分类名称 | Name | text, max 20 | yes | – |
| 分类图标 | Icon | picker | yes ("请选择分类图标") | – |
| 所属一级分类 | Parent | dropdown of level-1 + "＋新增" | yes | – |

- **New level-1:** "＋新增" opens the dialog "新增一级支出/收入分类" (name max 20, icon). On save the new level-1 is auto-selected as the parent.
- **Edit level-2 ("编辑二级支出分类"):** name, icon, **所属一级分类** (re-parent to any level-1) and **隐藏** 是/否.
- **Edit level-1:** name and icon only. It has no hide option.
- **Hide (level-2):**
  - The category disappears from the list (unless show-hidden is on) and from the new-transaction picker ("无匹配数据").
  - Existing transactions still count: the parent total and the report still include it.
- **Delete:** confirm "删除分类后，也会删除分类其下流水，并且关联分类的记一笔模板也将失效，确定删除吗？". Verified: deleting 测试支出子2 **deleted its 23.45 credit-card expense**, and the card balance went from 73.45 to 50.00.
  - There is no migrate or merge option on web.
  - This also shows that "记一笔模板" (entry templates) exist in the data model, but there is no web UI for them.
- **Reorder:** none.
- **Screenshots:** `21-categories-expense-tree`, `22-category-create-form`, `23-category-parent-dropdown`, `24-category-new-level1`, `25-category-edit-level2`, `55-category-delete-confirm`.
- **Tested?** Created L1 and L2 (expense and income), renamed, hidden, unhidden, deleted.

### 3.8 Merchants (商家管理)

- **Location:** sidebar → 商家管理.
- **List:** name / 结余 / 编辑, 删除, 查看流水, plus a "显示已隐藏的商家" checkbox.
- **Create:** "新增商家" carries a **专业会员** badge. Clicking it opens the Pro membership purchase page in a new tab. **Paywalled.**
- **Edit (free):** "编辑商家": 商家名称 (max 20), 商家图标, 隐藏 是/否 (the hide toggle has a 专业会员 badge). I renamed 超市 to 测试商家X (persisted).
- **Delete:** confirm "删除商家后，所关联的流水将被重置为无商家". Verified: the transaction's merchant became "-".
- **Merchant filter:** in 流水 筛选 it also has a 专业会员 badge.
- **Screenshots:** `26-merchants-list`, `27-merchant-create-paywall`, `28-merchant-edit`.
- **Tested?** Create: paywalled. Edit and delete: yes.

### 3.9 Projects (项目管理)

- **Location:** sidebar → 项目管理.
- **Structure:** two levels. 项目分类 (project category, e.g. "所有") sits above 项目.
- **Create (free):** "新增项目": 项目名称 (max 20), 项目图标, 所属项目分类 (default "所有（默认）"; choosing another parent carries a **专业会员** badge).
- **Edit:** adds 隐藏 是/否. Level-1 "编辑项目分类" has name and icon only.
- **Delete:** confirm "删除项目后，所关联的流水将被重置为无项目". Verified: the transaction kept, project became "-".
- **Screenshot:** `29-project-create`.
- **Tested?** Created, deleted. Edit form opened.

### 3.10 Transaction entry: 记一笔 (single entry)

- **Location:** the "＋记一笔" button (sidebar top) opens a left drawer. The drawer has two top tabs, **记一笔** and **记多笔**, plus a 数据导入 button. Inside 记一笔 there are five type tabs: **支出 / 收入 / 转账 / 余额 / 退款**.
- **No 借贷 / 代付 / 报销 tabs on web.** Those types do exist as filter values (§3.12).

**Expense / income / refund fields:**

| zh | en | type | req | default | validation / notes |
|---|---|---|---|---|---|
| 金额 | Amount | text with calculator icon, maxlength 13 | yes | – | letters stripped; **negative accepted and saved**; 2 decimals |
| 分类 | Category | searchable cascader (L1 › L2, plus "最近使用") | yes | last used | leaf required; hidden categories excluded |
| 账户 | Account | searchable cascader (type › account(currency)) | yes | last used | hidden accounts excluded |
| 记账时间 | Date-time | datetime picker | no (prefilled) | now, to the **second** (2026-11-15 21:15:36) | list shows minutes |
| 成员 | Member | cascader (所有/最近使用 › member) | no | 所有 / owner, then last used | – |
| 商家 | Merchant | cascader | no | empty | – |
| 项目 | Project | cascader | no | empty | – |
| 备注 | Note | textarea, max **2000** | no | Refund tab pre-fills "**#退款#**" | `#…#` hashtag style |
| 图片 | Images | upload, **max 9**, drag-and-drop; "上传高清原图" (HD original) toggle | no | off | not tested (no file uploads) |

- **Empty save:** toast "请输入必填项".
- **Buttons:** 保存 and 保存并再记一笔 (save and add another).
- **Defaults and memory:** the drawer remembers the last tab and last-used category, account and member. Switching tabs clears the amount.
- **Transfer (转账):**
  - Fields: 金额, **转出账户**, **转入账户**, 记账时间, 成员, 商家, 项目, 备注, 图片. There is no category.
  - **Cross-currency** (CNY → USD account): the amount area becomes **two amount fields**, "人民币CNY 66.71" and "美元USD 10.00". The second is auto-computed from the FX rate, and the destination balance rose by exactly 10 USD.
  - Both sides of the transfer accept any account type, including liability and receivable accounts. I used this for borrow, repay and lend.
- **Balance (余额):**
  - Fields: 账户, 余额 (prefilled with the current balance), 备注.
  - Saving creates a "余额变更" entry equal to the **delta** (300 → 280 gave ‑20.00).
- **Refund (退款):**
  - Same fields as expense, using **expense categories**. The note is pre-filled "#退款#".
  - Saved as an **expense of negative amount** (‑5.00) in the chosen category. It credits the account (+5).
  - There is **no link to the original expense** and no picker for one.
- **Screenshots:** `30-txn-expense-form`, `31-txn-category-picker`, `32-txn-expense-filled-negative`, `35-txn-transfer-form`, `36-txn-refund-form`, `37-txn-balance-form`, `38-txn-cross-currency-transfer`.
- **Tested?** Created: expense (incl. negative), income, transfer, credit-card purchase, card repayment (transfer A → card), refund (partial 5 of 12.34), balance set, cross-currency transfer, "loan" via liability account (borrow 300, repay 100), "lend" via receivable account (40).

### 3.11 Transaction entry: 记多笔 (multi-entry grid)

- **Grid columns:** \*流水类型 (收入/支出/转账), \*分类, \*金额, \*账户, \*时间, 图片, 备注, 项目, 成员, 商家.
- **Rows:** starts at 3; "添加一行" / "添加五行" add more, up to **60** ("已录入 3/60 条流水").
- **Save:** the 保存 button has a **基础会员** badge: "限免中：今天还可试用2次" (free trial, 2 uses left today).
- **Discard:** closing the drawer asks "是否放弃当前已录入数据？".
- **Screenshot:** `51-txn-multi-entry-grid`.
- **Tested?** Opened only (did not save).

### 3.12 Transaction list (流水)

- **Location:** sidebar 流水 (`#/book/transaction`).
- **Header:** 结余 / 收入 / 支出 for the current filter, plus 数据导入, 筛选, 搜索 and 批量编辑 buttons.
- **Left rail:** "汇总:" period selector (年/季/月/周/天) with per-period 结余/收入/支出 (e.g. 2026年 › 11月).
- **Grouping:** rows are grouped by day ("11月15日 今天").
- **Columns:**
  - 分类 (for transfers: "from-account → to-account")
  - 金额 (income red, expense blue; FX rows show "USD 10.00 折算 CNY 66.71")
  - 余额
  - 账户, 成员, 时间, 商家, 项目, 图片, 备注, 记账人
  - 操作: 编辑 / 复制 / 删除
- **Column settings (⚙):** show/hide and drag-reorder 账户, 成员, 时间, 商家, 项目, 图片, 备注, 记账人, plus "恢复默认排序". Screenshot `44`.
- **Filter (筛选 panel):**
  - 流水类型: 支出, 收入, 转账, 余额变更, 借入, 借出, 收债, 还债, 代付, 报销, 退款, 债权变更, 负债变更, 坏账, 免债
  - 时间筛选: start–end, or presets 今天/昨天/近7天/近30天/本周/上周/本月/上月/本季/上季/本年/去年
  - 分类, 账户 (multi-select tags)
  - 金额区间 (min–max)
  - 项目, 商家 (专业会员), 成员, 备注
  - Buttons 重置 / 确定
  - The filter **persists** across navigation: "已筛选" stays until reset.
- **Search:** a free-text box. "借" matched notes containing 借.
- **Edit ("编辑流水"):** same fields as creation, but **no type tabs**: the type cannot change. A transfer edit shows 转出/转入 账户.
- **Copy ("复制流水"):** a pre-filled form with the time reset to now. Saving creates a new transaction (verified).
- **Delete:** confirm "是否删除该流水", toast "流水删除成功". The transaction is gone from all totals immediately. No trash or undo is visible on web.
- **Batch:**
  - 批量编辑 adds row checkboxes and a footer "已选 N 条流水 | 批量修改 | 批量删除 | 取消".
  - 批量修改 dialog: tabs 支出(n)/收入(n)/其他(n), then fields 分类修改为 / 账户修改为 / 成员修改为 / 商家修改为 / 项目修改为.
  - 批量删除: confirm "确认删除当前选中共N条流水吗？". Verified deletion.
  - My batch-modify attempt (merchant) returned no error but did not persist. This may be my automation; **unverified**.
- **Export:** see §3.15.
- **Screenshots:** `33`, `34-txn-edit-form`, `40-txn-filter-panel`, `41-txn-copy-form`, `42-txn-batch-edit-mode`, `43-txn-batch-modify-dialog`, `44-txn-column-settings`, `57-txn-list-after-deletions`, `58-txn-edit-transfer-datetime`.
- **Tested?** Edit, copy, single delete, batch delete, search, filter: yes. Batch modify: opened, not confirmed working.

### 3.13 Reports (报表)

- **Location:** sidebar 报表 (`#/book/report`).
- **Tabs:** 基础统计, 分类, 账户, 成员, 项目, 商家, plus any added from **报表库**. Each tab has a period navigator (按年 / 按月 picker) and "生成图片".
- **基础统计 (basic stats):**
  - 账本流水统计: 结余, 总收入, 总支出, 记账笔数
  - 收入来源 and 支出分布, both by level-1
  - 月度收支趋势 line chart
  - 资产类账户统计 donut, with total assets
  - 负债类账户统计 donut, with total liabilities
- **分类:** 支出分类统计 and 收入分类统计 (donut plus level-2 ranking, totals and counts).
- **账户:** 账户统计 (净资产/资产/负债) with 负债明细 and 资产明细 percentages.
- **成员:** 成员记账数据 (count), 成员支出统计, 成员收支对比 (including "无成员"), 成员收入统计.
- **项目:** 总结余, 项目收入统计, **项目结余（毛利）统计** (project profit), 项目支出统计 (including "无项目").
- **商家:** 商家收支统计 (per merchant income/expense), 商家支出分布, 商家收入分布.
- **报表库 (report library):**
  - Recommended: 月报, 项目分类, 成本管理, 收入管理, 账户详情, 收入分类, 支出分类, plus the 6 already added.
  - Each card has 预览 (preview) → 添加. I added **月报**, which then appears as a tab: 月度小结, 最大的3笔支出, 最高的3笔收入, 收支趋势图, 本月支出/收入 vs last month, 支出分布, 收入来源.
- **Refund netting:** report category totals subtract refunds (测试支出子 = 12.34 − 5 = 7.34).
- **Inconsistency:** the home widget "本月支出情况" showed 35.79 (2 items) while the other widgets showed 30.79. That widget appears to ignore the negative refund.
- **Screenshots:** `45-report-basic-stats`, `46-report-category`, `47-report-library`, `48-report-monthly-added`.
- **Tested?** Viewed all tabs; added the 月报 report. Removing a report: not tried.

### 3.14 Home dashboard (首页) and customisation

- **Default widgets:** 本年收支统计, 本月支出情况 (daily chart), 本月各成员收支, 收支报告 (today/week/month), 本月各分类支出排行.
- **自定义首页 (`#/book/edit`, 基础会员 badge):** remove or drag existing modules. Addable modules:
  - 本月各成员收支统计
  - **本月预算及执行情况** (budget)
  - 今年每月的收支和结余统计
  - 罗列今天最大的3笔支出
  - 本月各成员收支对比统计
  - 本年每月支出统计柱状图
  - 每年收支和结余统计
  - 年度的收支对比
  - 展示最近记录的5条流水
  - 罗列本月最大的5笔支出
  - 显示当月每日收支记账情况
- **Screenshots:** `02-new-book-home`, `52-home-customize`.
- **Tested?** Opened; cancelled without saving.

### 3.15 Export (数据导出)

- **Location:** 设置 → 数据导出 (`#/book/setting/account-export`).
- **Fields:**
  - 流水类型 / 分类 / 账户 / 项目 / 商家 / 成员 (each default 全部)
  - 时间范围 presets (今天 … 去年, 自定义 date range; default 本月 2026-11-01 – 2026-11-30)
  - 金额区间
  - 是否导出流水图片 是/否 (default 否)
  - 备注 keyword
  - 重置 / **确认导出 (基础会员)**
- **Paywall:** clicking 确认导出 opened the Basic membership purchase page. **Paywalled.** Format per tile text: "导出Excel".
- **Screenshot:** `49-export-form`.
- **Tested?** Opened; paywalled.

### 3.16 Import (数据导入)

- **Location:** 设置 → 数据导入, or the 数据导入 button in 流水 and the drawer.
- **Wizard:** 1 上传文件 → 2 设置导入数据 → 3 导入数据.
- **Upload rules:** drag-and-drop or click. CSV / xls / xlsx, **≤2 MB**. Supports one-click WeChat/Alipay bill files, and other platforms via a downloadable 平台通用模板. **Only 收入, 支出 and 转账** types can be imported, with no images.
- **Also on the page:** an ad for the "随手记导入助手" browser plugin ("限时免费"), and a 导入记录 tab (columns 文件名称 / 操作人 / 操作时间 / 导入结果 / 操作).
- **Screenshot:** `50-import-upload`.
- **Tested?** Opened only (no file uploaded).

## 4. Summary table

| Feature | Chinese label | Observed behavior (1 line) | Status |
|---|---|---|---|
| Create book | 新建账本 / 账本模板 | Template click creates the book instantly with the template's name and seed data | Verified in Suishouji |
| Rename book | 账本设置 | Inline, max 16 chars, empty rejected silently | Verified in Suishouji |
| Delete book | 删除账本 | Confirm dialog; 7-day restore only in the mobile app | Verified (delete); restore not present on web |
| Base currency / month start / 封账 / 结转 / transfer owner | – | No UI anywhere on web | Not present on web |
| Book trash / txn trash | 回收站 | No UI on web; only the book-trash mention in the delete dialog | Not present on web |
| Operation log | 操作日志 | Only a role-permission checkbox | Not present on web |
| Members (placeholder) | 成员管理 / 新建待邀请成员 | Icon + name(16); hide; delete unlinks txns | Verified in Suishouji |
| Invite users | 邀请 | Not exercised (policy) | Not accessible (policy) |
| Roles & permissions | 角色管理 / 权限设置 | 4 built-in roles; custom roles with add/edit/delete/view scopes; paid per person-day | Verified in Suishouji |
| Accounts CRUD | 账户管理 | 7 types, identical fields; currency; hidden; count-in-assets | Verified in Suishouji |
| Credit-card fields (limit, statement/due day) | – | Not on web form | Not present on web |
| Balance edit adjustment | 余额变更 / 负债变更 | Opening balance and edits create delta entries | Verified in Suishouji |
| Account delete | 删除 | Deletes the account and all its txns, incl. transfers | Verified in Suishouji |
| Account reorder / reconciliation | – | None | Not present on web |
| Categories CRUD | 收支分类 | 2 levels, re-parent L2, hide L2, icon required | Verified in Suishouji |
| Category delete | 删除 | Deletes all its transactions; no migrate | Verified in Suishouji |
| Merchants | 商家管理 | Edit/delete free; create Pro-only | Partially verified / Paywalled (create) |
| Projects | 项目管理 | Create/delete free; parent selection Pro-only | Verified in Suishouji |
| Expense / income | 记一笔 支出/收入 | Amount, category, account, time(s), member, merchant, project, note(2000), images(9) | Verified in Suishouji |
| Transfer | 转账 | One record, from/to; dual amounts across currencies | Verified in Suishouji |
| Credit-card purchase & repayment | 支出 / 转账 | Purchase raises the liability; transfer to the card lowers it | Verified in Suishouji |
| Refund | 退款 | Negative expense in an expense category, note "#退款#", no link to the original | Verified in Suishouji |
| Set balance | 余额 | Creates 余额变更 for the delta | Verified in Suishouji |
| Loans (borrow/lend) | 借贷 | No web tab; modelled here as transfers via liability/receivable accounts | Partially verified (workaround only) |
| 代付 / 报销 | – | Filter values only, no web entry | Not present on web |
| Multi-entry grid | 记多笔 | Up to 60 rows, 3 types; Basic membership (2 free trials/day) | Opened only / Paywalled |
| Edit / copy / delete txn | 编辑/复制/删除 | Type locked on edit; copy resets time; delete is immediate | Verified in Suishouji |
| Batch modify / delete | 批量编辑 | Batch delete works; batch modify dialog opened, change not confirmed | Partially verified |
| Filter / search / group | 筛选 / 搜索 / 汇总 | 15 types, time presets, amount range, dims; persisted | Verified in Suishouji |
| Column settings | ⚙ | Show/hide and reorder columns | Verified (opened) |
| Reports | 报表 | 6 default tabs plus library; year/month period | Verified in Suishouji |
| Report library | 报表库 | Preview and add (月报 added) | Verified in Suishouji |
| Home customisation | 自定义首页 | Module add/remove/reorder; Basic membership | Opened only / Paywalled |
| Budget | 预算 | Only a home widget option; no management UI | Not present on web |
| Recurring / reminders | 周期记账 / 提醒 | None | Not present on web |
| Export | 数据导出 | Rich filter form; export needs Basic membership | Paywalled |
| Import | 数据导入 | CSV/xls/xlsx ≤2MB, 3-step wizard, history | Opened only |
| Images on transactions | 图片 | Up to 9, HD toggle | Opened only (no upload) |
| Multi-currency | 币种 | 128 currencies; auto FX conversion to CNY | Verified in Suishouji |

## 5. Data-model observations for a database designer

1. **Transfers are a single record** holding both a from-account and a to-account.
   - It shows as one row in 流水 ("测试账户A → 测试现金B") and once in each account's filtered view.
   - Edit shows both accounts.
   - Cross-currency transfers store **two amounts**, source and destination currency (66.71 CNY / 10.00 USD).
   - Deleting either account deletes the transfer, which changes the other account's balance.
2. **Credit cards are plain liability-type accounts** (信用账户) with balance = amount owed.
   - A purchase is a normal expense on that account and raises the liability (100 → 123.45).
   - A repayment is a normal transfer from a debit account to the card and lowers the liability (123.45 → 73.45) without touching income or expense.
   - The web has no statement cycle, credit limit or due date.
3. **Refunds are standalone negative expenses.**
   - The refund tab saves `type=expense, amount=-5.00`, using an expense category and the note tag "#退款#". The account is credited.
   - **There is no foreign key to the original expense**, so "partial refund" just means a smaller negative amount.
   - Category reports net refunds. One home widget ("本月支出情况") does not, which gives inconsistent totals.
   - The filter list includes a separate "退款" type, so the underlying model may carry a refund type/flag. On web the observable result is a negative expense.
4. **Deletions cascade differently by object:**

   | Object deleted | Effect on its transactions |
   |---|---|
   | Category | **Hard-deletes** them |
   | Account | **Hard-deletes** them, including transfers touching other accounts |
   | Member | Transactions remain; member reference **cleared (null)** |
   | Merchant | Transactions remain; merchant reference **cleared (null)** |
   | Project | Transactions remain; project reference **cleared (null)** |

   No migrate-to-another-category or merge option exists on web.
5. **Balance edits create adjustment entries.**
   - The opening balance, edits in the account form, and the 余额 tab all create a delta transaction typed 余额变更 (assets) or 负债变更 (liabilities). The filter also lists 债权变更 (receivables).
   - A zero opening balance creates no entry.
   - Adjustment entries are excluded from income and expense totals but are ordinary, editable and deletable rows.
   - So an account balance = Σ(adjustments) + Σ(income) − Σ(expense) ± transfers. The account stores no separate "initial balance" field.
6. **Hidden objects:**
   - Hidden accounts and level-2 categories disappear from management lists (unless "show hidden" is on) and from entry pickers.
   - Their transactions stay in lists and reports. A hidden category still counts in the parent total and the category report.
   - The separate account flag **计入资产=否** is what excludes a balance from 总资产, net worth, group subtotals and the asset donut.
   - Members, merchants and projects also have a hidden flag.
7. **Amounts:**
   - Strings are sanitised to digits, minus sign and a decimal point, with **2 decimal places** (truncated, not rounded: ‑12.345 → ‑12.34).
   - Max length: 13 characters in the transaction amount field, 15 in the account balance field.
   - **Negative amounts are accepted** for expenses (a ‑12.34 expense saved, reducing 支出 and raising 结余) and for account balances.
   - The UI shows thousands separators (1,000.00).
8. **Date-time:**
   - Stored to the **second** (edit shows "2026-11-15 21:18:28"); lists show minutes.
   - Creation defaults to now; copy resets to now.
   - "Today" and the period buckets on the dashboard used 2026-11-16 while entries were stamped 2026-11-15 ~21:xx browser local time. The server likely buckets by China time (UTC+8), so time zone handling is a design consideration.
9. **Currency:**
   - Each account has a currency; there is no web control for a book base currency, which appears to be CNY.
   - Foreign balances are auto-converted (USD rate ≈ 6.671 on 2026-11-15) for totals and display ("折算 CNY").
   - Transactions in a foreign account store the original currency amount.
   - There is no manual exchange-rate table on web.
10. **Trash:**
    - Transaction delete and batch delete are immediate, with no web recycle bin.
    - Book delete is soft (7-day restore window, app only).
    - I could not determine what the trash retains (not on web).
11. **Operation log:** only visible as a role permission (操作日志). No web viewer, so its contents are unknown.
12. **Hierarchies:**
    - Categories: 2 levels; transactions attach to the leaf.
    - Projects: 2 levels (项目分类 › 项目).
    - Pickers present members, merchants and projects under a pseudo-root "所有", plus a "最近使用" group.
    - Accounts are grouped by type; type is immutable after creation.
13. **Other transaction attributes:** 记账人 (the user who recorded it, distinct from 成员), images (≤9), and a note (≤2000) with `#tag#` convention.
14. **Permissions model** (useful if multi-user is planned):
    - Per-role add/edit/delete/view, each with scope all / own / custom.
    - Per-base-data manage rights for accounts, categories, projects, merchants and members.
    - A log-view right.
    - Sensitive-data rights: view balances, view assets/liabilities.
15. **Validation gaps observed:**
    - A custom role could be created with an empty name.
    - The account "隐藏" choice at creation did not persist; it only worked via edit. This may be my automation.
    - Book name: an empty value is silently reverted rather than raising an error.
