import { dayPart, personalize } from "../services/greeting";
import { localToday } from "@billie/finance-core";
import { useCallback, useEffect, useState } from "react";
import { NicknamePrompt } from "../components/NicknamePrompt";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { Overview } from "../overview/Overview";
import { localSources } from "../overview/local";
import messages from "../overview/messages.json";
import type { Action, Activity, Scope } from "../overview/model";
import type { Page, TransactionIntent } from "../App";
import type { TransactionFilter } from "../commands/handlers";

export function Dashboard({
  go, focus,
}: {
  focus?: string | null;
  go: (page: Page, part?: string | null, filter?: TransactionFilter, intent?: TransactionIntent) => void;
}) {
  const finance = useFinance();
  const { account } = useAccount();
  const { m, locale } = useI18n();
  const c = messages[locale];
  const { activeDatabaseId, databaseIds, databaseName, openStore, accounts, currency, ownerKey, statements } =
    finance;
  const [names, setNames] = useState<Record<string, string | null>>({});
  const list = databaseIds.join("|");
  useEffect(() => {
    let live = true;
    const ids = list.split("|").filter((id) => id !== activeDatabaseId);
    void Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await (await openStore(id)).databaseName()] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (live) setNames(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, [list, activeDatabaseId, openStore]);
  let today = localToday();
  try {
    if (account?.timeZone)
      today = new Intl.DateTimeFormat("sv-SE", {
        timeZone: account.ianaTimeZone ?? account.timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
  } catch {
    /* Older accounts may have only a Rails display name. */
  }
  const sources = useCallback(
    (scope: Scope) => localSources(finance, scope, today, (name) => categoryLabel(m, name)),
    [finance, m, today],
  );
  const base = currency ?? accounts[0]?.currency ?? "USD";
  const zone = account?.ianaTimeZone ?? account?.timeZone;
  let part = dayPart();
  try {
    if (zone) {
      const hour = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(new Date()),
      );
      part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
    }
  } catch {
    /* Use the device clock for legacy named zones. */
  }
  const context = {
    locale,
    today,
    greeting: personalize(m.personal.greeting[part], account?.nickname ?? null),
    owner: ownerKey ?? "preview",
    ledger: activeDatabaseId,
    currency: base,
    currencies: [
      ...new Set([base, ...accounts.map((a) => a.currency), ...statements.map((s) => s.currency)].filter(Boolean)),
    ],
    accounts: accounts.map((a) => ({
      id: String(a.id),
      name: a.unassigned ? m.ledger.accounts.unassigned : a.name,
      currency: a.currency ?? base,
    })),
    ledgers: databaseIds.map((id, i) => ({
      id,
      name:
        (id === activeDatabaseId ? databaseName : names[id]) ||
        c.device + (databaseIds.length > 1 ? " " + (i + 1) : ""),
    })),
  };
  function navigate(action: Action, scope: Scope, category?: string, activity?: Activity) {
    if (action === "transactions")
      go("transactions", null, {
        accountId: scope.account ? Number(scope.account) : undefined,
        currency: scope.currency,
        category,
        activity,
        period: { start: scope.period.startDate, end: scope.period.endDate },
      });
    else if (action === "addEntry") go("transactions", null, undefined, { entryKind: "expense" });
    else if (action === "bills" || action === "budget") go("planning", action === "bills" ? "schedules" : null);
    else if (action === "insight") go("assistant", "insights");
    else if (action === "addAccount") go("accounts");
    else if (action === "report") go("reports");
    else if (action !== "forecast") go(action);
  }
  return (
    <>
      <Overview
        key={context.owner + ":" + activeDatabaseId}
        focusWidget={focus === "forecast" ? "forecast" : undefined}
        context={context}
        sources={sources}
        navigate={navigate}
        switchLedger={finance.switchDatabase}
      />
      <NicknamePrompt ownerKey={ownerKey} />
    </>
  );
}
