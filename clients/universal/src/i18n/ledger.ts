// Messages for manual bookkeeping (accounts, entries, trash, categories tree, merchants/projects/
// tags, budgets, recurring entries, reports, backup, operation log, "Organize with AI") and the
// account-owner protection. English is the reference; test/i18n.test.ts checks every language
// has the same keys and placeholders.

export const ledgerEn = {
  owner: {
    claimTitle: "Is this database yours?",
    claimBody: "This device has a database from an earlier version of BillieWeather that holds financial data but does not record which account it belongs to. If it is yours, it will be kept for this account. If it is not, it stays on this device untouched and you get a new, empty database.",
    claimMine: "Yes, it's mine",
    claimNotMine: "No, leave it alone",
    noRoom: "This device has no free database for this account. Sign in with the account that owns the existing databases to remove one.",
  },
  nav: { accounts: "Accounts", planning: "Budgets & schedules", lists: "Merchants & tags" },
  kinds: { expense: "Expense", income: "Income", refund: "Refund", transfer: "Transfer", card_payment: "Card payment", opening_balance: "Opening balance", adjustment: "Balance adjustment", ignored: "Not counted" },
  accountTypes: { checking: "Checking / debit", savings: "Savings", cash: "Cash", payment_app: "Payment app / wallet", investment: "Investment", receivable: "Money owed to me", credit_card: "Credit card", loan: "Loan / liability", other: "Other" },
  common: { save: "Save", cancel: "Cancel", edit: "Edit", delete: "Delete", archive: "Archive", unarchive: "Restore", rename: "Rename", merge: "Merge into…", moveUp: "Move up", moveDown: "Move down", none: "None", optional: "optional", add: "Add", close: "Close", saving: "Saving…", saved: "Saved.", showArchived: "Show archived", entries: "{count} entries", confirmDelete: "Delete for good? This cannot be undone." },
  problems: {
    amount_required: "Enter an amount.", amount_zero: "The amount can't be zero.", amount_too_large: "That amount is too large.", amount_precision: "Use at most two decimal places.",
    date_invalid: "Choose a valid date.", account_required: "Choose an account.", accounts_same: "Choose two different accounts.", category_kind: "That category belongs to the other tree (income vs. expense).",
    refund_target_required: "Choose the expense this refund belongs to.", refund_too_large: "The refunds would be more than the original expense.", kind_invalid: "Choose a type.",
  },
  errors: {
    not_found: "It no longer exists.", invalid_name: "Enter a name.", name_taken: "That name is already used.", account_in_use: "This account has entries, so it can't be deleted. Archive it instead.",
    invalid_account_type: "Choose an account type.", invalid_entry: "Check the highlighted fields.", refund_too_large: "The refunds would be more than the original expense.",
    category_depth: "That category can't be moved there.", category_protected: "Transfers can't be deleted, merged into another category or moved under one.", category_cycle: "A category can't contain itself.", invalid_budget: "Check the budget.", invalid_schedule: "Check the dates and frequency.",
    currency_unknown: "Choose this book's currency first.", not_in_trash: "Only entries in the trash can be deleted for good.", unknown: "Something went wrong.",
  },
  accounts: {
    eyebrow: "WHERE YOUR MONEY IS", title: "Accounts", intro: "Bank accounts, cards, cash and wallets. Balances are the opening balance plus every entry; transfers move money between your accounts and never count as income or spending.",
    assets: "Assets", liabilities: "Liabilities", netWorth: "Net worth", owed: "Owed", available: "Available credit",
    add: "Add account", newTitle: "New account", editTitle: "Edit account", name: "Name", type: "Type", institution: "Bank or provider", last4: "Last 4 digits",
    openingBalance: "Opening balance", openingBalanceHelp: "What the account held before the first entry here. For a card, enter what you owed as a negative number.", openingOn: "As of",
    creditLimit: "Credit limit", statementDay: "Statement day", dueDay: "Payment due day", includeInNetWorth: "Include in net worth", note: "Note",
    adjust: "Adjust balance", adjustTitle: "Set the real balance", adjustHelp: "Enter what the bank or wallet shows now. One balance-adjustment entry records the difference; it never counts as income or spending.", actualBalance: "Actual balance", adjustDone: "Balance adjusted by {amount}.", adjustNone: "The balance already matches.",
    unassigned: "Imported (no account)", estimated: "Estimated from an imported statement — set the real balance to be sure.", unknownBalance: "Opening balance unknown — set the real balance.",
    currency: "Book currency", currencyHelp: "This book has no imports yet. Choose the currency its accounts use.", empty: "No accounts yet", emptyBody: "Add your first account — a bank account, a card, or the cash in your wallet.", archived: "Archived",
    deleted: "Account deleted.", archivedDone: "Account archived.", restoredDone: "Account restored.",
  },
  entry: {
    add: "New entry", newTitle: "New entry", editTitle: "Edit entry", type: "Type", amount: "Amount", date: "Date", time: "Time", account: "Account", from: "From account", to: "To account",
    category: "Category", merchant: "Merchant / payee", project: "Project", tags: "Tags", tagsHelp: "Separate with commas.", note: "Note", description: "Description",
    original: "Original text from the bank: {text}", refundOf: "Refund of", refundPick: "Choose the original expense…", refundable: "{amount} refundable", adjustmentHelp: "Enter the change: positive adds money, negative removes it. To set a target balance, use Adjust balance on the Accounts page.",
    created: "Entry saved.", updated: "Entry updated.", copied: "Copied as a new entry.", deletedToTrash: "Moved to the trash.", copy: "Copy",
    importedNote: "Imported from a statement: the bank's amount and date are kept as they are.",
  },
  list: {
    kind: "Type", allKinds: "All types", account: "Account", allAccounts: "All accounts", merchant: "Merchant", project: "Project", tag: "Tag", any: "Any",
    select: "Select {description}", selectAll: "Select all shown", selected: "{count} selected", batchCategory: "Set category…", batchMerchant: "Set merchant", batchProject: "Set project", batchTag: "Add tag", batchApply: "Apply", batchDelete: "Move to trash", batchDone: "{count} entries updated.",
    trash: "Trash", trashTitle: "Trash", trashIntro: "Deleted entries stay here until you delete them for good. Restoring a transfer restores both sides.", restore: "Restore", purge: "Delete for good", emptyTrash: "Empty trash", trashEmpty: "The trash is empty.",
    emptyConfirm: "Delete all {count} entries in the trash for good? This cannot be undone.", purgeConfirm: "Delete “{description}” for good? This cannot be undone.",
    backToList: "Back to transactions", restored: "Restored.", purged: "Entries deleted for good: {count}.",
    review: "Review", reviewTitle: "Money in that may not be income", reviewIntro: "These rows count as income, but look like refunds or card repayments. Refunds reduce spending; card repayments are transfers.", markAs: "Mark as {kind}", keepIncome: "It is income",
  },
  categoriesTree: {
    title: "Category tree", intro: "Categories nest as deeply as you like, like folders and subfolders. A subcategory belongs to its top-level category's tree (income, expense or transfer). Hidden categories keep their history but are not offered for new entries. Transfers can be renamed and given subcategories, but not deleted or moved under another category.",
    parent: "Parent", topLevel: "Top level", tree: "Tree", expense: "Expense", income: "Income", hidden: "Hidden", hide: "Hide", show: "Show", deleteMoveTo: "Move its entries to", merged: "Merged {from} into {into}.",
    expand: "Show subcategories of {name}", collapse: "Hide subcategories of {name}", renameTo: "New name for {name}", addSub: "Add subcategory", subName: "New subcategory under {name}", move: "Move", moveUnder: "Move {name} under",
    addSuggested: "Add suggested categories", suggestedHelp: "Adds the default categories you don't have yet. Nothing you have is renamed, moved or duplicated.", suggestedAdded: "Added {count} suggested categories.", suggestedNone: "You already have every suggested category.", actionsFor: "Actions for {name}",
  },
  lists: {
    eyebrow: "EXTRA DETAIL", title: "Merchants, projects & tags", intro: "Optional labels for entries. A merchant is who you paid or who paid you; a project groups entries across categories (a trip, a renovation); tags are free labels.",
    merchant: "Merchants", project: "Projects", tag: "Tags", newName: "New name", empty: "None yet.", mergeInto: "Merge into", deleteHelp: "Entries keep everything else; this label is removed from them.",
  },
  planning: {
    eyebrow: "PLAN AHEAD", title: "Budgets & schedules",
    budgets: "Budgets", budgetsIntro: "A spending limit per month or year, for everything or for one category or project. You are warned at the alert level.", addBudget: "Add budget", period: "Period", month: "Monthly", year: "Yearly",
    scope: "For", everything: "All spending", alert: "Warn at (%)", spent: "{spent} of {limit}", left: "{amount} left", over: "{amount} over", periodRange: "{from} – {to}", noBudgets: "No budgets yet.",
    monthStart: "Month starts on day", monthStartHelp: "For budgets and monthly views, e.g. your payday.",
    schedules: "Recurring entries", schedulesIntro: "Rent, salary, subscriptions. Due entries are posted when you choose — or automatically when the app opens, if you allow it.", addSchedule: "Add schedule",
    name: "Name", frequency: "Repeats", frequencies: { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" }, every: "Every", startOn: "First date", endOn: "Last date",
    autoPost: "Post automatically when due", next: "Next: {date}", ended: "Ended", paused: "Paused", pause: "Pause", resume: "Resume", skip: "Skip next", postDue: "Post {count} due entries", posted: "{count} entries posted.", preview: "Next dates: {dates}", noSchedules: "No recurring entries yet.",
  },
  reports: {
    direct: "{name} (direct)", drill: "Show inside {name}", drillUp: "All top-level categories",
    by: "Group by", dimensions: { category: "Category", account: "Account", merchant: "Merchant", project: "Project", tag: "Tag", month: "Month" }, income: "Income", expense: "Spending", net: "Net", count: "Entries", unlabeled: "(none)",
    netWorthTitle: "Net worth over time", assets: "Assets", liabilities: "Liabilities", netWorth: "Net worth", month: "Month",
  },
  backup: {
    title: "Backup & restore", intro: "A backup is a complete copy of this database in one file that you keep. It never leaves this device unless you move the file yourself.",
    create: "Back up now", passphrase: "Passphrase (optional)", passphraseHelp: "Encrypts the file. Without the passphrase, nobody — not even you — can restore it.", created: "Backup saved ({rows} rows).",
    restore: "Restore from a backup", restoreHelp: "Restoring creates a NEW database next to your existing ones. Nothing existing is changed.", choose: "Choose backup file", restorePassphrase: "This backup is encrypted. Enter its passphrase.", restoring: "Restoring and verifying…",
    restored: "Restored as “{name}” and verified: every row and total matches the backup.", restoredName: "{name} (restored)",
    snapshots: "Automatic copies before updates", snapshotsIntro: "Before an update changes how data is stored, BillieWeather copies each database file. The two newest copies are kept.", noSnapshots: "No automatic copies yet.", restoreSnapshot: "Open as a new database", snapshotRestored: "The copy was opened as a new database.",
    errors: { not_a_backup: "That file is not a BillieWeather backup.", newer_version: "That backup was made by a newer version. Update BillieWeather first.", passphrase_required: "Enter the backup's passphrase.", wrong_passphrase: "Wrong passphrase, or the file is damaged.", damaged: "The backup file is damaged or was changed.", target_not_empty: "Backups are restored into a new, empty database only.", verify_failed: "The restored copy did not match the backup, so it was removed. Your existing data was not changed.", no_room: "There is no free database slot on this device. Remove a database first.", other_account: "That copy belongs to another account on this device, so it was not opened." },
  },
  activity: {
    title: "Activity log", intro: "Every change to this book: who or what made it (you, an import, a rule, AI, a schedule) and when. Stored only on this device.", empty: "Nothing yet.",
    actors: { user: "You", import: "Import", rule: "Rule", ai: "AI", system: "System", sync: "Website copy", recurring: "Schedule" },
    actions: { undo: "Undone", redo: "Redone", create: "Created", update: "Changed", delete: "Deleted", restore: "Restored", purge: "Deleted for good", link: "Linked", unlink: "Unlinked", import: "Imported", reverse_import: "Import removed", ai_apply: "AI change", ai_undo: "AI change undone", batch_update: "Batch edit", batch_delete: "Batch delete", merge: "Merged", archive: "Archived", unarchive: "Restored", backup: "Backed up", restore_backup: "Restored from backup" },
    subjects: { history: "change", transaction: "entry", account: "account", category: "category", merchant: "merchant", project: "project", tag: "tag", budget: "budget", recurring_rule: "schedule", statement: "statement", batch: "AI batch", book: "book" },
    undo: "Undo this AI batch", undone: "Undone ({count} changes).",
  },
  organize: {
    button: "Organize with AI", title: "Organize my finances", intro: "BillieWeather looks for uncategorized entries, transfers between your accounts, card repayments, refunds, duplicates and recurring payments, and suggests changes. Nothing changes until you approve.",
    analyze: "Analyze", analyzing: "Analyzing…", engineLocal: "On this device (rules, no network)", engineCloud: "Also ask BillieWeather AI for categories (sends only cleaned merchant names)", cloudConsent: "Merchant names only — no amounts, dates, accounts or descriptions. Your own categories are offered as choices.",
    nothing: "Nothing to suggest — your books look organized.", found: "{count} suggestions", apply: "Apply {count} selected", applied: "{count} changes applied. You can undo them all from the activity log or right here.", undo: "Undo all", undone: "Undone.",
    selectAll: "Select all", confidence: "{percent}% sure", reason: "Why: {reason}", discard: "Discard",
    kinds: { categorize: "Categorize", transfer: "Transfer between your accounts", card_payment: "Card repayment", refund: "Refund of an earlier purchase", duplicate: "Possible duplicate", recurring: "Recurring payment", merchant: "Clean merchant name", suspect_income: "Not really income" },
    describe: { categorize: "{description} → {category}", transfer: "{from} → {to}, {amount}", refund: "{refund} refunds {original}", duplicate: "{description} on {date} appears twice", recurring: "{description}: about every {days} days, {amount}", merchant: "{description} → {merchant}", suspect_income: "{description} → {kind}" },
    reasons: { rule: "matches your remembered merchants", keywords: "matches common merchant words", ai: "suggested by AI", opposite: "same amount out and in within 3 days in two of your accounts", refund_words: "same merchant, money back after the purchase", same_row: "same account, date, amount and text", cadence: "same merchant and amount at a regular interval", merchant_words: "bank codes and numbers removed", account_type: "money in on a card or a refund word" },
    autoRules: "Also remember each accepted category for its merchant", recurringCreate: "Create schedule",
  },
  mode: { label: "Interface mode", default: "AI Automatic", manual: "Manual Accounting", defaultHelp: "Simple, automation-first view", manualHelp: "The complete manual bookkeeping workspace", manualOn: "Manual Mode", draftRestored: "Your unfinished input was restored.", draftDiscard: "Discard draft", groups: { record: "Record", organize: "Accounts & lists", plan: "Plan & report", automatic: "Automatic tools" } },
  manual: { nav: "Manual home", eyebrow: "MANUAL MODE", title: "Manual bookkeeping", intro: "Every tool for keeping your books by hand, grouped by task. These are the same records you see in Default Mode.", quickAdd: "Record an entry", quickAddBody: "Choose a type to start.", recent: "Recent manual entries", recentEmpty: "No manual entries yet.", sameRecords: "Default Mode and Manual Mode show the same records. Switching modes never copies, changes or deletes anything.", tools: { entry: "Expense, income, transfer, card payment, refund or balance adjustment.", transactions: "Search, filter by type, account, merchant, project or tag; edit, copy and batch edit.", accounts: "Accounts: {count}. Assets, liabilities and debts; set the real balance to reconcile.", categories: "Two-level income and expense categories you can arrange, hide and merge.", lists: "Merchants, projects and tags: create, rename, merge and archive.", planning: "Budgets with a warning, and recurring entries you can post, skip or pause.", reports: "By category, account, merchant, project, tag or month, with net worth over time.", reviewTitle: "Review & trash", review: "Income to check, the trash, and organizing with AI.", bookTitle: "Books, backup & activity", book: "Create and rename books (databases), back up and restore, and see every change." } },
};

type Widen<T> = T extends string ? string : T extends readonly string[] ? string[] : { [K in keyof T]: Widen<T[K]> };
export type LedgerMessages = Widen<typeof ledgerEn>;
