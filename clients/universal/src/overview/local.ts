import { buildSnapshot, isCounted, kindOf, newestFirst } from "@billie/finance-core";
import type { Transaction, Statement, Currency } from "@billie/shared-types";
import type { useFinance } from "../hooks/useFinance";
import type { Account } from "../services/ledger";
import { project, position, schedule, within, type Sources, type Scope, type Day, type Position } from "./model";

export function currencyLookup(
  accounts: Pick<Account, "id" | "currency">[],
  statements: Pick<Statement, "id" | "currency">[],
  base: string,
) {
  const accountCodes = new Map(accounts.map((a) => [a.id, a.currency]));
  const statementCodes = new Map(statements.map((s) => [s.id, s.currency]));
  return (tx: Transaction) => statementCodes.get(tx.statementId) ?? accountCodes.get(tx.accountId ?? -1) ?? base;
}

export function localSources(
  finance: ReturnType<typeof useFinance>,
  scope: Scope,
  today: string,
  label: (name: string) => string,
): Sources {
  const { transactions, statements, accounts, currency, categoryTree, store } = finance;
  const code = currencyLookup(accounts, statements, currency ?? scope.currency);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const scoped = transactions.filter(
    (t) => (!scope.account || String(t.accountId) === scope.account) && code(t) === scope.currency,
  );
  const selected = scoped.filter((t) => within(t.bookedOn, scope.period));
  const snapshot = () =>
    buildSnapshot({
      transactions: selected,
      statements: [],
      currency: scope.currency as Currency,
      period: scope.period,
    });
  let days: Day[] | undefined;
  function flow() {
    if (days) return days;
    const grouped = new Map<string, Day>();
    for (const tx of scoped) {
      const day = grouped.get(tx.bookedOn) ?? { date: tx.bookedOn, income: 0, expenses: 0, counted: false };
      if (isCounted(tx)) {
        day.counted = true;
        if (kindOf(tx) === "income") day.income += tx.amountCents;
        else day.expenses -= tx.amountCents;
      }
      grouped.set(tx.bookedOn, day);
    }
    days = [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
    return days;
  }
  function holdings(): Position {
    const future = new Map<number, number>();
    const mixed = new Set<number>();
    for (const t of transactions) {
      if (t.accountId == null) continue;
      if (code(t) !== (byId.get(t.accountId)?.currency ?? currency)) mixed.add(t.accountId);
      if (t.bookedOn > today) future.set(t.accountId, (future.get(t.accountId) ?? 0) + t.amountCents);
    }
    return {
      extraCash: null,
      cashOverride: null,
      holdings: accounts
        .filter(
          (a) => (!scope.account || String(a.id) === scope.account) && (a.currency ?? currency) === scope.currency,
        )
        .map((a) => ({
          type: a.type,
          liability: a.accountClass === "liability",
          included: a.includeInNetWorth && !a.archived,
          archived: a.archived,
          balance:
            a.unassigned ||
            mixed.has(a.id) ||
            a.openingBalanceSource === "unknown" ||
            (a.openingBalanceOn && a.openingBalanceOn > today)
              ? null
              : a.balanceCents - (future.get(a.id) ?? 0),
        })),
    };
  }
  return {
    flow: async () => flow(),
    position: async () => holdings(),
    spending: async () =>
      snapshot().categories.map((cat) => ({
        amount: cat.amountCents,
        path: [...categoryTree.ancestors(cat.name), cat.name].map((name) => ({ name, label: label(name) })),
      })),
    recent: async () =>
      [...selected]
        .sort(newestFirst)
        .slice(0, 6)
        .map((tx) => ({
          id: tx.id,
          date: tx.bookedOn,
          name: tx.description,
          category: label(tx.category),
          account: byId.get(tx.accountId ?? -1)?.name ?? null,
          amount: tx.amountCents,
        })),
    bills: async () =>
      (await store.ledger.recurringRules())
        .flatMap((rule) => {
          const account = byId.get(rule.template.accountId);
          if (
            rule.paused ||
            rule.template.kind !== "expense" ||
            !account ||
            account.currency !== scope.currency ||
            (scope.account && String(account.id) !== scope.account)
          )
            return [];
          return schedule(rule.startOn, rule.nextOn, rule.endOn, rule.frequency, rule.interval, today).map(
            (date) => ({ date, name: rule.name, amount: rule.template.amountCents, account: account.name }),
          );
        })
        .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
    budget: async () => {
      if (scope.account || scope.currency !== currency) return null;
      const budgets = (await store.ledger.budgets(today)).filter(
        (b) => b.period === "month" && !b.category && b.projectId === null,
      );
      if (budgets.length !== 1) return null;
      const b = budgets[0],
        spent = buildSnapshot({
          transactions: scoped,
          statements: [],
          currency,
          period: { startDate: b.from, endDate: b.to },
        }).expensesCents;
      return b.amountCents - spent;
    },
    forecast: async () => project(flow(), position(holdings()).available, today),
    insight: async () => null,
  };
}
