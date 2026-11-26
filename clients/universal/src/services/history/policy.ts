// Which operations of the book are edits a person can undo. Every public method that writes is listed in one of
// the two lists (test/history.test.ts fails for one that is not), so a new operation cannot be left out silently.
import type { FinanceStore } from "../store";
import type { LedgerStore } from "../ledger";
import type { HistoryAction } from "./history";

type Recorded<T> = { readonly [K in keyof T]?: HistoryAction | ((...args: never[]) => HistoryAction | null) };

export const RECORDED_STORE: Recorded<FinanceStore> = {
  addCategory: "category_list", renameCategory: "category_list", deleteCategory: "category_list", mergeCategory: "category_list",
  moveCategory: "category_list", addSuggestedCategories: "category_list",
  applyAiCategories: "organize", applyAiCategoriesBatch: "organize", approveAiProposal: "organize",
  importStatement: "import", commitImport: "import", reverseImport: "reverse_import",
  setCategory: "category", setCategoryMany: "batch_edit", setExcluded: "exclude", reclassifyStatements: "reclassify",
  setStatementRegion: "region", keepStatementRegion: "region", deleteRule: "rule", restoreRules: "command_undo", restoreTransactionFlags: "command_undo",
};

export const RECORDED_LEDGER: Recorded<LedgerStore> = {
  createAccount: "account", updateAccount: "account", setAccountArchived: "account", deleteAccount: "account", reorderAccounts: "account", adjustBalance: "balance",
  createDimension: "label_list", renameDimension: "label_list", setDimensionArchived: "label_list", mergeDimension: "label_list", deleteDimension: "label_list",
  setCategoryMeta: "category_list", reorderCategories: "category_list", moveCategoryStep: "category_list",
  createEntry: "create", updateEntry: "edit", duplicateEntry: "duplicate", deleteEntries: "delete", restoreEntries: "restore",
  batchUpdate: "batch_edit", setTags: "edit", setKind: "kind", linkRefund: "link", linkTransfer: "link", markDuplicate: "link", undoBatch: "organize_undo",
  saveBudget: "budget", deleteBudget: "budget", saveRecurringRule: "schedule", setRecurringPaused: "schedule", deleteRecurringRule: "schedule", skipOccurrence: "schedule",
  // Posting by schedule when the book opens is not an edit of the person.
  postDue: (_today?: string, options?: { onlyAuto?: boolean }) => (options?.onlyAuto ? null : "post_schedule"),
  setBookCurrency: "settings", setMonthStartDay: "settings",
};

/** Writes that are not undoable edits, and why. */
export const NOT_RECORDED: Readonly<Record<string, string>> = {
  purgeEntries: "permanent by design", emptyTrash: "permanent by design", removeStatement: "permanent by design", deleteAllData: "permanent by design",
  applyWebData: "the website's change, not the person's", detachWebCopies: "follows a permanent cloud deletion", allowDownload: "download preference", mergeData: "copies another database; the copy is removed as statements",
  audit: "append-only log", accountForImport: "part of an import", unassignedAccountId: "part of an import", dimensionId: "part of an edit",
  bookUuid: "identity of the book", reportId: "identity of the book", setOwner: "identity of the book", setDatabaseName: "name of the database",
  setCategoryExpanded: "view preference (expanded or collapsed in the tree), never part of an edit", ensureCategorySeed: "first-open setup of the default categories",
  markSynced: "sync state", markWebChecked: "sync state", setWebSyncEnabled: "preference", saveTemplate: "import template", deleteTemplate: "import template",
};
