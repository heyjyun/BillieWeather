import type { PeriodPreset } from "@billie/shared-types";
import { buildSnapshot, localToday, resolvePeriod, spendingMix, spendingPalette } from "@billie/finance-core";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CategoryBadge, Empty, Money, PeriodPicker } from "../components/common";
import { GreetingHeader } from "../components/Greeting";
import { IncomeMix, MonthlyCashFlow } from "../components/OverviewCharts";
import { NicknamePrompt } from "../components/NicknamePrompt";
import { SpendingMixChart } from "../components/SpendingCharts";
import { useFinance } from "../hooks/useFinance";
import { useModules } from "../hooks/useModules";
import { useI18n } from "../i18n";
import { overviewCopy } from "../i18n/overview";
import type { Page } from "../App";

export function Dashboard({ go }: { go: (page: Page, part?: string | null) => void }) {
  const { m, locale, t } = useI18n();
  const finance = useFinance();
  const { transactions, statements, currency, ownerKey, accounts, activeDatabaseId, databaseIds, databaseName, openStore, switchDatabase } = finance;
  const { usable } = useModules();
  const [period, setPeriod] = useState(() => resolvePeriod("all_time", { today: localToday() }));
  const [dates, setDates] = useState({ startDate: "", endDate: "" });
  const [dateError, setDateError] = useState(false);
  const [bookChoice, setBookChoice] = useState<{ id: string; account: string } | null>(null);
  const [names, setNames] = useState<Record<string, string | null>>({});
  const [switching, setSwitching] = useState(false);
  const [bookError, setBookError] = useState(false);
  const cur = currency ?? "USD";
  const selected = bookChoice?.id === activeDatabaseId ? bookChoice.account : "";
  const accountId = accounts.find((account) => String(account.id) === selected)?.id;
  const scoped = useMemo(() => accountId === undefined ? transactions : transactions.filter((tx) => tx.accountId === accountId), [accountId, transactions]);
  const snap = useMemo(() => buildSnapshot({ transactions: scoped, statements, period, currency: cur }), [scoped, statements, period, cur]);
  const palette = useMemo(() => spendingPalette(transactions), [transactions]);
  const mix = useMemo(() => spendingMix(scoped, palette, period), [scoped, palette, period]);
  const d = m.dashboard;
  const copy = overviewCopy[locale];
  const databaseList = databaseIds.join("|");

  useEffect(() => {
    let active = true;
    const ids = databaseList.split("|").filter((id) => id && id !== activeDatabaseId);
    void Promise.all(ids.map(async (id) => {
      try { return [id, await (await openStore(id)).databaseName()] as const; }
      catch { return [id, null] as const; }
    })).then((entries) => { if (active) setNames(Object.fromEntries(entries)); });
    return () => { active = false; };
  }, [activeDatabaseId, databaseList, openStore]);

  async function changeLedger(id: string) {
    setSwitching(true);
    setBookError(false);
    try {
      await switchDatabase(id);
      setBookChoice(null);
    } catch {
      setBookError(true);
    } finally {
      setSwitching(false);
    }
  }

  function changePeriod(preset: PeriodPreset) {
    setPeriod(resolvePeriod(preset, { today: localToday() }));
    setDateError(false);
  }

  function applyDates(event: FormEvent) {
    event.preventDefault();
    try {
      setPeriod(resolvePeriod("custom", { today: localToday(), ...dates }));
      setDateError(false);
    } catch {
      setDateError(true);
    }
  }

  const reset = () => {
    setBookChoice(null);
    setDates({ startDate: "", endDate: "" });
    changePeriod("all_time");
  };
  const hasData = transactions.length > 0;

  return (
    <>
      <GreetingHeader eyebrow={d.eyebrow} hasData={hasData} needsAttention={snap.uncategorizedCount > 0} />
      <NicknamePrompt ownerKey={ownerKey} />
      <section className="bw-panel bw-overview-filters" aria-label={m.periods.label}>
        <div className="bw-overview-scope">
          <label className="bw-field">
            <span>{copy.ledger}</span>
            <select value={activeDatabaseId} disabled={switching || databaseIds.length < 2} onChange={(event) => void changeLedger(event.target.value)}>
              {databaseIds.map((id, index) => <option key={id} value={id}>
                {(id === activeDatabaseId ? databaseName : names[id]) || copy.deviceLedger + (databaseIds.length > 1 ? " " + (index + 1) : "")}
              </option>)}
            </select>
          </label>
          <label className="bw-field">
            <span>{copy.account}</span>
            <select value={accountId === undefined ? "" : String(accountId)} disabled={switching} onChange={(event) =>
              setBookChoice({ id: activeDatabaseId, account: event.target.value })}>
              <option value="">{copy.allAccounts}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          </label>
        </div>
        <PeriodPicker value={period.preset} onChange={changePeriod} />
        <form className="bw-overview-dates" onSubmit={applyDates}>
          <label className="bw-field"><span>{copy.startDate}</span><input type="date" value={dates.startDate} onChange={(event) => setDates({ ...dates, startDate: event.target.value })} /></label>
          <label className="bw-field"><span>{copy.endDate}</span><input type="date" value={dates.endDate} onChange={(event) => setDates({ ...dates, endDate: event.target.value })} /></label>
          <button className="bw-button bw-button-outline" type="submit">{copy.applyDates}</button>
        </form>
        {dateError && <p role="alert" className="bw-message bw-message-error">{copy.invalidDates}</p>}
        {bookError && <p role="alert" className="bw-message bw-message-error">{copy.ledgerError}</p>}
      </section>
      {switching ? <p role="status">{copy.switching}</p> : !hasData ? (
        <Empty title={d.emptyTitle} body={d.emptyBody} action={<button className="bw-button bw-button-dark" onClick={() => go("import")}>{d.emptyAction}</button>} />
      ) : dateError ? null : (
        <>
          <section className={"bw-metrics bw-overview-metrics" + (accountId === undefined ? "" : " bw-overview-scoped")} aria-label={d.totals}>
            <article className="bw-metric" id="dashboard-income"><span>{d.income}</span><strong><Money cents={snap.incomeCents} currency={cur} /></strong></article>
            <article className="bw-metric" id="dashboard-expenses"><span>{d.spending}</span><strong><Money cents={snap.expensesCents} currency={cur} /></strong></article>
            <article className="bw-metric bw-overview-net" id="dashboard-net"><span>{d.net}</span><strong><Money cents={snap.netCents} currency={cur} signed /></strong></article>
            {accountId === undefined && <article className="bw-metric bw-metric-accent">
              <span>{d.balance}</span>
              <strong>{snap.balanceCents === null ? "—" : <Money cents={snap.balanceCents} currency={cur} />}</strong>
              <small>{snap.balanceOn ? t("dashboard.asOf", { date: snap.balanceOn }) : d.noBalance}</small>
            </article>}
          </section>
          {snap.transactionCount === 0 ? (
            <Empty title={copy.noMatches} body="" action={<button className="bw-button bw-button-outline" onClick={reset}>{copy.reset}</button>} />
          ) : (
            <>
              {snap.uncategorizedCount > 0 && <button className="bw-notice" onClick={() => go("transactions")}>{t("dashboard.needCategory", { count: snap.uncategorizedCount })}</button>}
              <div className="bw-overview-analysis">
                <MonthlyCashFlow months={snap.monthly} currency={cur} />
                <section className="bw-panel" aria-labelledby="categories-heading" id="dashboard-spending-mix">
                  <div className="bw-panel-top">
                    <h2 id="categories-heading">{copy.spendingByCategory}</h2>
                    {usable("categories") && <button type="button" className="bw-link-button" onClick={() => go("categories")}>{m.spending.allCategories}</button>}
                  </div>
                  <SpendingMixChart mix={mix} currency={cur} emptyText={d.noSpending}
                    onOpen={usable("categories") ? (category) => go("categories", category) : undefined} />
                </section>
                <IncomeMix categories={snap.incomeCategories} currency={cur} />
              </div>
              <section className="bw-panel" aria-labelledby="recent-heading">
                <div className="bw-panel-top">
                  <h2 id="recent-heading">{d.recent}</h2>
                  <button type="button" className="bw-link-button" onClick={() => go("transactions")}>{copy.viewAll}</button>
                </div>
                <ul className="bw-tx-list">
                  {snap.recentTransactions.map((tx) => (
                    <li key={tx.id} className={tx.excluded ? "is-excluded" : ""}>
                      <div><strong>{tx.description}</strong><small>{tx.bookedOn}</small></div>
                      <CategoryBadge category={tx.category} />
                      <Money cents={tx.amountCents} currency={cur} signed />
                    </li>
                  ))}
                </ul>
                <p className="bw-caption">{t("dashboard.notCounted", { transfers: snap.transferCount, excluded: snap.excludedCount })}</p>
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
