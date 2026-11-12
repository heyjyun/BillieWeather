// Trusted-side handlers: each command runs through the app's existing FinanceStore methods, the
// same ones the pages use. The local SQLite driver has no multi-statement transactions (Tauri's
// SQL plugin pools connections), so bulk changes record the exact previous state first and put it
// back if anything fails: all-or-nothing by compensation. The same record powers Undo.

import type { ActionArguments, ActionHandler, Authorizer, DateRangeValue, EntityProvider, Message, MoneyValue } from "@nlae/core";
import type { Category, MerchantRule, Transaction } from "@billie/shared-types";
import { formatMoney, isBuiltInCategory, merchantKey, normalizeCategoryName } from "@billie/finance-core";
import type { FinanceStore, TransactionFlags } from "../services/store";
import type { Page } from "../App";
import { categoryEntities } from "./actions";

/** At most this many transactions change in one command; larger changes belong on the pages. */
export const MAX_BULK = 500;

export interface TransactionFilter {
  query?: string;
  category?: string;
  period?: DateRangeValue;
  amount?: MoneyValue;
}

export interface HostDeps {
  store: FinanceStore;
  /** The current data of the database in use. */
  data: () => { transactions: readonly Transaction[]; customCategories: readonly string[]; currency: string | null };
  refresh: () => Promise<void>;
  navigate: (page: Page, filter?: TransactionFilter) => void;
  setLanguage: (locale: string) => void;
  setTheme: (theme: "light" | "dark" | "system") => void;
  categoryLabel: (name: string) => string;
}

const msg = (code: string, message: string, vars: Record<string, string | number> = {}): Message => ({ code, message, vars });
const fold = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Same rule for previews, totals and changes: description contains the phrase (or same merchant). */
export function matchTransactions(transactions: readonly Transaction[], filter: TransactionFilter): Transaction[] {
  const query = filter.query ? fold(filter.query) : "";
  const queryMerchant = filter.query ? merchantKey(filter.query) : null;
  return transactions.filter((t) => {
    if (query && !fold(t.description).includes(query) && !(queryMerchant && merchantKey(t.description) === queryMerchant)) return false;
    if (filter.category && t.category !== filter.category) return false;
    if (filter.period?.start && t.bookedOn < filter.period.start) return false;
    if (filter.period?.end && t.bookedOn > filter.period.end) return false;
    if (filter.amount) {
      const size = Math.abs(t.amountCents);
      const target = filter.amount.amountMinor;
      const ok = { eq: size === target, gt: size > target, gte: size >= target, lt: size < target, lte: size <= target }[filter.amount.comparator];
      if (!ok) return false;
    }
    return true;
  });
}

const filterOf = (args: ActionArguments): TransactionFilter => ({
  query: typeof args.query === "string" ? args.query : undefined,
  category: typeof args.category === "string" ? args.category : undefined,
  period: (args.period as DateRangeValue | undefined) ?? undefined,
  amount: (args.amount as MoneyValue | undefined) ?? undefined,
});

/** Spending/income exactly as the dashboard counts it: excluded rows and transfers never count. */
const counted = (t: Transaction) => !t.excluded && t.category !== "Transfers";

export function createEntities(deps: Pick<HostDeps, "data" | "categoryLabel">): EntityProvider {
  return {
    list(kind) {
      const { customCategories } = deps.data();
      if (kind === "category") return categoryEntities(customCategories, deps.categoryLabel);
      if (kind === "customCategory") return customCategories.map((name) => ({ id: name, label: name }));
      return [];
    },
  };
}

/** Signed in, and the plan was made for the database in use (the tenant includes its id). */
export function createAuthorizer(): Authorizer {
  return {
    authorize({ ctx }) {
      if (!ctx.principal) return { allowed: false, code: "unauthenticated", message: "Sign in first." };
      if (!ctx.tenant.startsWith(`${ctx.principal}#`)) return { allowed: false, code: "forbidden", message: "This database belongs to another account." };
      return { allowed: true };
    },
  };
}

type FlagsPayload = { flags: TransactionFlags[] };

async function withCompensation<T>(store: FinanceStore, ids: number[], apply: () => Promise<T>): Promise<{ result: T; before: TransactionFlags[] }> {
  const before = await store.transactionFlags(ids);
  try {
    return { result: await apply(), before };
  } catch (error) {
    await store.restoreTransactionFlags(before).catch(() => undefined);
    throw error;
  }
}

export function createHandlers(deps: HostDeps): Record<string, ActionHandler> {
  const currency = () => deps.data().currency ?? "USD";
  const matches = (args: ActionArguments) => matchTransactions(deps.data().transactions, filterOf(args));
  const describe = (t: Transaction) => ({ kind: "transaction", id: String(t.id), label: `${t.bookedOn} · ${t.description}` });

  const readOnly = (op: string, label: string) => ({ operations: [{ op, target: { kind: "view", id: label, label } }] });

  const setExcluded = (excluded: boolean): ActionHandler<number[]> => ({
    async prepare(args) {
      const rows = matches(args).filter((t) => t.excluded !== excluded);
      if (rows.length > MAX_BULK) return { operations: [], summary: msg("too_many", `More than ${MAX_BULK} transactions match. Narrow it down.`, { max: MAX_BULK }) };
      if (!rows.length) return { operations: [], summary: msg("no_match", "No transactions match.") };
      return { operations: rows.map((t) => ({ op: "update", target: describe(t), before: { excluded: t.excluded }, after: { excluded } })), payload: rows.map((t) => t.id) };
    },
    async execute(prepared) {
      const ids = prepared.payload!;
      const { before } = await withCompensation(deps.store, ids, async () => { for (const id of ids) await deps.store.setExcluded(id, excluded); });
      await deps.refresh();
      return { summary: msg(excluded ? "excluded" : "included", excluded ? "{count} transaction(s) excluded from totals." : "{count} transaction(s) counted again.", { count: ids.length }), undo: { flags: before } satisfies FlagsPayload };
    },
    async undo(payload) {
      await deps.store.restoreTransactionFlags((payload as FlagsPayload).flags);
      await deps.refresh();
      return msg("undone", "Undone.");
    },
  });

  return {
    "app.navigate": {
      async prepare(args) { return readOnly("navigate", String(args.page)); },
      async execute(_p, args) {
        deps.navigate(args.page as Page);
        return { summary: msg("navigated", "Opened {page}.", { page: String(args.page) }) };
      },
    },
    "transactions.find": {
      async prepare() { return readOnly("read", "transactions"); },
      async execute(_p, args) {
        const count = matches(args).length;
        deps.navigate("transactions", filterOf(args));
        return { summary: msg("found", "{count} matching transaction(s).", { count }), data: { count } };
      },
    },
    "finance.spending": {
      async prepare() { return readOnly("read", "spending"); },
      async execute(_p, args) {
        const rows = matches(args).filter((t) => counted(t) && t.amountCents < 0);
        const total = rows.reduce((sum, t) => sum - t.amountCents, 0);
        return { summary: msg("spending_total", "Spent {amount} across {count} transaction(s).", { amount: formatMoney(total, currency()), count: rows.length }), data: { totalCents: total, count: rows.length } };
      },
    },
    "finance.income": {
      async prepare() { return readOnly("read", "income"); },
      async execute(_p, args) {
        const rows = matches(args).filter((t) => counted(t) && t.amountCents > 0);
        const total = rows.reduce((sum, t) => sum + t.amountCents, 0);
        return { summary: msg("income_total", "Received {amount} across {count} transaction(s).", { amount: formatMoney(total, currency()), count: rows.length }), data: { totalCents: total, count: rows.length } };
      },
    },
    "transactions.categorize": {
      async prepare(args) {
        const category = String(args.category);
        const rows = matches({ ...args, category: undefined as never }).filter((t) => t.category !== category);
        if (rows.length > MAX_BULK) return { operations: [], summary: msg("too_many", `More than ${MAX_BULK} transactions match. Narrow it down.`, { max: MAX_BULK }) };
        if (!rows.length) return { operations: [], summary: msg("no_match", "No transactions match.") };
        return {
          operations: rows.map((t) => ({ op: "update", target: describe(t), before: { category: t.category }, after: { category } })),
          payload: rows.map((t) => t.id),
        };
      },
      async execute(prepared, args) {
        const ids = prepared.payload as number[];
        const category = String(args.category) as Category;
        const { before } = await withCompensation(deps.store, ids, () => deps.store.setCategoryMany(ids, category));
        await deps.refresh();
        return { summary: msg("categorized", "{count} transaction(s) moved to {category}.", { count: ids.length, category: deps.categoryLabel(category) }), undo: { flags: before } satisfies FlagsPayload };
      },
      async undo(payload) {
        await deps.store.restoreTransactionFlags((payload as FlagsPayload).flags);
        await deps.refresh();
        return msg("undone", "Undone.");
      },
    },
    "transactions.exclude": setExcluded(true) as ActionHandler,
    "transactions.include": setExcluded(false) as ActionHandler,
    "categories.create": {
      async prepare(args) {
        const name = normalizeCategoryName(String(args.name));
        const existing = deps.data().customCategories;
        if (isBuiltInCategory(name) || existing.some((c) => c.toLowerCase() === name.toLowerCase())) return { operations: [], summary: msg("category_exists", "{name} already exists.", { name }) };
        return { operations: [{ op: "create", target: { kind: "category", id: name, label: name } }] };
      },
      async execute(_p, args) {
        const stored = await deps.store.addCategory(String(args.name));
        await deps.refresh();
        return { summary: msg("category_created", "Created category {name}.", { name: stored }), undo: { name: stored } };
      },
      async undo(payload) {
        const { name } = payload as { name: string };
        // Compensation only while nothing uses it; otherwise the person's later work would be lost.
        if (deps.data().transactions.some((t) => t.category === name)) throw new Error("The category is in use now, so it was kept.");
        await deps.store.deleteCategory(name);
        await deps.refresh();
        return msg("undone", "Undone.");
      },
    },
    "categories.rename": {
      async prepare(args) {
        const from = String(args.from);
        const to = normalizeCategoryName(String(args.to));
        if (to === from) return { operations: [], summary: msg("same_name", "That is already its name.") };
        const affected = deps.data().transactions.filter((t) => t.category === from).length;
        return { operations: [{ op: "rename", target: { kind: "category", id: from, label: from }, before: from, after: to }], summary: msg("rename_preview", "{count} transaction(s) use it.", { count: affected }) };
      },
      async execute(_p, args) {
        const stored = await deps.store.renameCategory(String(args.from), String(args.to));
        await deps.refresh();
        return { summary: msg("category_renamed", "Renamed {from} to {to}.", { from: String(args.from), to: stored }), undo: { from: stored, to: String(args.from) } };
      },
      async undo(payload) {
        const { from, to } = payload as { from: string; to: string };
        await deps.store.renameCategory(from, to);
        await deps.refresh();
        return msg("undone", "Undone.");
      },
    },
    "categories.delete": {
      async prepare(args) {
        const name = String(args.target);
        const moved = deps.data().transactions.filter((t) => t.category === name);
        return {
          operations: [
            { op: "delete", target: { kind: "category", id: name, label: name } },
            ...moved.map((t) => ({ op: "update", target: describe(t), before: { category: name }, after: { category: "Uncategorized" } })),
          ],
          payload: moved.map((t) => t.id),
        };
      },
      async execute(prepared, args) {
        const name = String(args.target);
        const ids = prepared.payload as number[];
        const flags = await deps.store.transactionFlags(ids);
        const rules: MerchantRule[] = (await deps.store.rules()).filter((r) => r.category === name);
        await deps.store.deleteCategory(name);
        await deps.refresh();
        return { summary: msg("category_deleted", "Deleted {name}; {count} transaction(s) are now Uncategorized.", { name, count: ids.length }), undo: { name, flags, rules } };
      },
      async undo(payload) {
        const { name, flags, rules } = payload as { name: string; flags: TransactionFlags[]; rules: MerchantRule[] };
        await deps.store.addCategory(name);
        await deps.store.restoreTransactionFlags(flags);
        await deps.store.restoreRules(rules);
        await deps.refresh();
        return msg("undone", "Undone.");
      },
    },
    "app.language": {
      async prepare(args) { return { operations: [{ op: "set", target: { kind: "preference", id: "language", label: "language" }, after: args.language }] }; },
      async execute(_p, args) {
        deps.setLanguage(String(args.language));
        return { summary: msg("language_set", "Language changed.") };
      },
    },
    "app.theme": {
      async prepare(args) { return { operations: [{ op: "set", target: { kind: "preference", id: "theme", label: "theme" }, after: args.theme }] }; },
      async execute(_p, args) {
        deps.setTheme(args.theme as "light" | "dark" | "system");
        return { summary: msg("theme_set", "Appearance changed.") };
      },
    },
  };
}
