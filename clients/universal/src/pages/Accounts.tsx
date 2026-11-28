// Accounts (账户): every place money is, grouped into assets and liabilities, with balances and net
// worth. Create, edit, reorder, archive / restore, delete an unused account, and record the real
// balance (余额) as one adjustment entry.
import { ACCOUNT_TYPES, formatMoney, isLiability, type AccountType } from "@billie/finance-core";
import { CURRENCIES } from "@billie/shared-types";
import { useEffect, useState, type FormEvent } from "react";
import { useDraftState, useMode } from "../hooks/useMode";
import { currencyOptions, SearchableSelect } from "../components/SearchableSelect";
import { AccountCapture } from "../components/AccountCapture";
import copy from "../../../../packages/shared-types/schema/assistant-copy.json";
import { institutions } from "../../../../public/account-capture.mjs";
import { useAccount } from "../hooks/useAccount";
import { statementObservations, type StatementObservation } from "../services/statementObservations";
import { Money, PageHeading } from "../components/common";
import { parseAmount } from "../components/EntryForm";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import { LedgerError, type Account, type AccountInput } from "../services/ledger";

const bookCurrencies = currencyOptions(CURRENCIES);

const today = () => new Date().toISOString().slice(0, 10);

type AccountFormProps = { account: Account | null; currency: string; onDone: (message: string) => void; onCancel: () => void };

// The account form's fields are a draft (see useMode), kept across a switch to Default Mode and back.
function AccountForm(props: AccountFormProps) {
  const { m } = useI18n();
  const { hasDraft, clearDraft } = useMode();
  const draftKey = `account-${props.account?.id ?? "new"}`;
  const [generation, setGeneration] = useState(0);
  const [restored, setRestored] = useState(() => hasDraft(draftKey));
  const finish = (done: () => void) => { clearDraft(draftKey); done(); };
  return (
    <>
      {restored && (
        <p className="bw-message bw-draft-note" role="status">
          {m.ledger.mode.draftRestored}{" "}
          <button type="button" className="bw-link-button" onClick={() => { clearDraft(draftKey); setRestored(false); setGeneration((g) => g + 1); }}>{m.ledger.mode.draftDiscard}</button>
        </p>
      )}
      <AccountFormFields key={generation} {...props} draftKey={draftKey} onDone={(message) => finish(() => props.onDone(message))} onCancel={() => finish(props.onCancel)} />
    </>
  );
}

function AccountFormFields({ account, currency, onDone, onCancel, draftKey }: AccountFormProps & { draftKey: string }) {
  const { m, locale } = useI18n();
  const text = copy[locale];
  const { account: owner } = useAccount();
  const x = m.ledger.accounts;
  const { store, refresh } = useFinance();
  const [name, setName] = useDraftState(draftKey, "name", account?.name ?? "");
  const [type, setType] = useDraftState<AccountType>(draftKey, "type", account?.type ?? "checking");
  const [institution, setInstitution] = useDraftState(draftKey, "institution", account?.institution ?? "");
  const [last4, setLast4] = useDraftState(draftKey, "last4", account?.last4 ?? "");
  const [opening, setOpening] = useDraftState(draftKey, "opening", account && account.openingBalanceSource !== "unknown" ? ((isLiability(account.type) ? -1 : 1) * account.openingBalanceCents / 100).toFixed(2) : "");
  const [openingOn, setOpeningOn] = useDraftState(draftKey, "openingOn", account?.openingBalanceOn ?? "");
  const [limit, setLimit] = useDraftState(draftKey, "limit", account?.creditLimitCents !== null && account?.creditLimitCents !== undefined ? (account.creditLimitCents / 100).toFixed(2) : "");
  const [statementDay, setStatementDay] = useDraftState(draftKey, "statementDay", account?.statementDay ? String(account.statementDay) : "");
  const [dueDay, setDueDay] = useDraftState(draftKey, "dueDay", account?.dueDay ? String(account.dueDay) : "");
  const [include, setInclude] = useDraftState(draftKey, "include", account?.includeInNetWorth ?? true);
  const [note, setNote] = useDraftState(draftKey, "note", account?.note ?? "");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const openingCents = parseAmount(opening, true);
    const limitCents = limit.trim() ? parseAmount(limit) : null;
    if ((opening.trim() && openingCents === null) || (limit.trim() && limitCents === null)) return setError(m.ledger.problems.amount_required);
    const day = (text: string) => (text.trim() ? Math.min(31, Math.max(1, Math.trunc(Number(text)))) : null);
    const input: AccountInput = {
      name: name.trim() || [institution, m.ledger.accountTypes[type]].filter(Boolean).join(" "), type, institution: institution || null, last4: last4 || null, openingBalanceCents: openingCents !== null && isLiability(type) ? -openingCents : openingCents, openingBalanceOn: openingOn || null,
      creditLimitCents: isLiability(type) ? limitCents : null, statementDay: type === "credit_card" ? day(statementDay) : null, dueDay: isLiability(type) ? day(dueDay) : null,
      includeInNetWorth: include, note: note || null,
    };
    try {
      if (account) await store.ledger.updateAccount(account.id, input);
      else await store.ledger.createAccount({ ...input, currency });
      await refresh();
      onDone(m.ledger.common.saved);
    } catch (caught) {
      setError(caught instanceof LedgerError ? m.ledger.errors[caught.code] ?? m.ledger.errors.unknown : m.ledger.errors.unknown);
    }
  }

  return (
    <form className="bw-panel bw-entry-form" aria-label={account ? x.editTitle : x.newTitle} onSubmit={submit}>
      <h2>{account ? x.editTitle : x.newTitle}</h2>
      <div className="bw-form-grid">
        <label className="bw-field"><span>{x.name}</span><input list="manual-account-names" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={[institution, m.ledger.accountTypes[type]].filter(Boolean).join(" ")} /><datalist id="manual-account-names">{[...new Set([m.ledger.accountTypes[type],[institution,m.ledger.accountTypes[type]].filter(Boolean).join(" ")])].map(n => <option key={n} value={n} />)}</datalist></label>
        <label className="bw-field">
          <span>{x.type}</span>
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {ACCOUNT_TYPES.map((option) => <option key={option} value={option}>{m.ledger.accountTypes[option]}</option>)}
          </select>
        </label>
        <label className="bw-field"><span>{x.institution} <small>({m.ledger.common.optional})</small></span><input list="manual-account-banks" value={institution} onChange={(e) => setInstitution(e.target.value)} maxLength={60} /><datalist id="manual-account-banks">{(institutions[owner?.usageRegion || ""] || []).map(bank => <option key={bank} value={bank} />)}</datalist></label>
        <label className="bw-field"><span>{x.last4} <small>({m.ledger.common.optional})</small></span><input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" /></label>
        <label className="bw-field"><span>{isLiability(type) ? text.owed : type === "cash" ? text.cash : text.balance}</span><input inputMode="decimal" placeholder={text.unknown} value={opening} onChange={(e) => setOpening(e.target.value)} /></label>
      </div><details><summary>{text.advanced}</summary><div className="bw-form-grid">
        <label className="bw-field"><span>{x.openingOn} <small>({m.ledger.common.optional})</small></span><input type="date" value={openingOn} onChange={(e) => setOpeningOn(e.target.value)} /></label>
        {isLiability(type) && <label className="bw-field"><span>{x.creditLimit} <small>({m.ledger.common.optional})</small></span><input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>}
        {type === "credit_card" && <label className="bw-field"><span>{x.statementDay} <small>({m.ledger.common.optional})</small></span><input type="number" min={1} max={31} value={statementDay} onChange={(e) => setStatementDay(e.target.value)} /></label>}
        {isLiability(type) && <label className="bw-field"><span>{x.dueDay} <small>({m.ledger.common.optional})</small></span><input type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} /></label>}
        <label className="bw-check"><input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> {x.includeInNetWorth}</label>
        <label className="bw-field bw-grow"><span>{x.note} <small>({m.ledger.common.optional})</small></span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
      </div></details>
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
      <div className="bw-actions">
        <button type="submit" className="bw-button bw-button-dark">{m.ledger.common.save}</button>
        <button type="button" className="bw-button bw-button-outline" onClick={onCancel}>{m.ledger.common.cancel}</button>
      </div>
    </form>
  );
}

function AdjustForm({ account, onDone, onCancel }: { account: Account; onDone: (message: string) => void; onCancel: () => void }) {
  const { m, locale } = useI18n();
  const x = m.ledger.accounts;
  const { store, refresh } = useFinance();
  const [target, setTarget] = useState(account.openingBalanceSource === "unknown" ? "" : ((isLiability(account.type) ? -1 : 1) * account.balanceCents / 100).toFixed(2));
  const [date, setDate] = useState(today());
  const [observation, setObservation] = useState<StatementObservation>();
  useEffect(() => {
    let active = true;
    void statementObservations(store,today()).then(rows => { if (active) setObservation(rows.find(r => r.id === account.id)); }).catch(() => {});
    return () => { active = false; };
  },[account.id,store]);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parseAmount(target, true);
    if (cents === null) return setError(m.ledger.problems.amount_required);
    try {
      await store.ledger.adjustBalance(account.id, isLiability(account.type) ? -cents : cents, date);
      await refresh();
      onDone(m.ledger.common.save + " · " + formatMoney(cents, account.currency));
    } catch (err) {
      setError(err instanceof LedgerError && err.problems.includes("date_invalid") ? m.ledger.problems.date_invalid : copy[locale].failure);
    }
  }
  return (
    <form className="bw-panel bw-entry-form" aria-label={x.adjustTitle} onSubmit={submit}>
      <h2>{x.adjustTitle}: {account.name}</h2>
      <p className="bw-caption">{x.adjustHelp}</p>
      {observation && <button type="button" className="bw-link-button" onClick={() => { setDate(observation.day); setTarget((observation.cents/100).toFixed(2)); }}>
        {copy[locale].observed} · {observation.filename} · {observation.day} · {formatMoney(observation.cents,account.currency)}</button>}
      <div className="bw-form-grid">
        <label className="bw-field"><span>{isLiability(account.type) ? copy[locale].owed : x.actualBalance}</span><input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
        <label className="bw-field"><span>{m.ledger.entry.date}</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
      <div className="bw-actions">
        <button type="submit" className="bw-button bw-button-dark">{x.adjust}</button>
        <button type="button" className="bw-button bw-button-outline" onClick={onCancel}>{m.ledger.common.cancel}</button>
      </div>
    </form>
  );
}

export function Accounts({ create = false, onStatement, adjustId, suggestion }: { suggestion?: string; create?: boolean; onStatement?: () => void; adjustId?: number } = {}) {
  const { m, locale } = useI18n();
  const x = m.ledger.accounts;
  const { store, accounts, currency, refresh } = useFinance();
  // Which form is open is part of the draft too, so it reopens after a mode switch.
  const [editing, setEditing] = useDraftState<Account | "new" | null>("accounts-page", "editing", null);
  useEffect(() => { if (create) setEditing(old => old ?? "new"); }, [create, setEditing]);
  const [adjusting, setAdjusting] = useState<Account | null>(null);
  useEffect(() => { if (adjustId) setAdjusting(accounts.find(a => a.id === adjustId) ?? null); }, [adjustId, accounts]);
  const [showArchived, setShowArchived] = useState(false);
  const [status, setStatus] = useState("");
  const [bookCurrency, setBookCurrency] = useState("USD");
  const visible = accounts.filter((account) => showArchived || !account.archived);
  const included = accounts.filter(a => !a.archived && a.includeInNetWorth);
  const live = included.filter(a => a.openingBalanceSource !== "unknown");
  const onlyUnknown = (group: Account[]) => group.length > 0 && group.every(a => a.openingBalanceSource === "unknown");
  const assets = live.filter((account) => !isLiability(account.type)).reduce((sum, account) => sum + account.balanceCents, 0);
  const liabilities = live.filter((account) => isLiability(account.type)).reduce((sum, account) => sum - account.balanceCents, 0);
  const cur = currency ?? accounts[0]?.currency ?? bookCurrency;
  const done = (message: string) => { setEditing(null); setAdjusting(null); setStatus(message); };

  async function act(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      await refresh();
      setStatus(message);
    } catch (caught) {
      setStatus(caught instanceof LedgerError ? m.ledger.errors[caught.code] ?? m.ledger.errors.unknown : m.ledger.errors.unknown);
    }
  }
  async function move(account: Account, step: -1 | 1) {
    const order = accounts.filter((a) => !a.archived).map((a) => a.id);
    const index = order.indexOf(account.id);
    const swap = index + step;
    if (index < 0 || swap < 0 || swap >= order.length) return;
    [order[index], order[swap]] = [order[swap], order[index]];
    await act(() => store.ledger.reorderAccounts(order), m.ledger.common.saved);
  }

  const groups: Array<{ title: string; items: Account[] }> = [
    { title: x.assets, items: visible.filter((account) => !isLiability(account.type)) },
    { title: x.liabilities, items: visible.filter((account) => isLiability(account.type)) },
  ];
  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title}>

      </PageHeading>
      <AccountCapture suggestion={suggestion} currency={cur} manual={() => setEditing("new")} statement={() => onStatement?.()} />
      <div className="bw-next-slot" data-account-next-slot />
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      {status && <p className="bw-message bw-message-ok">{status}</p>}
      {!currency && accounts.length === 0 && (
        <div className="bw-field">
          <label htmlFor="accounts-book-currency">{x.currency}</label>
          <SearchableSelect id="accounts-book-currency" kind="currency" options={bookCurrencies} value={bookCurrency}
            onChange={setBookCurrency} aria-describedby="accounts-book-currency-help" />
          <small id="accounts-book-currency-help">{x.currencyHelp}</small>
        </div>
      )}
      {accounts.some(a => !a.archived && a.openingBalanceSource === "unknown") && <p className="bw-caption">{copy[locale].partial}</p>}
      <div className="bw-metrics">
        <div className="bw-metric"><span>{x.assets}</span><strong>{onlyUnknown(included.filter(a => !isLiability(a.type))) ? "—" : <Money cents={assets} currency={cur} />}</strong></div>
        <div className="bw-metric"><span>{x.liabilities}</span><strong>{onlyUnknown(included.filter(a => isLiability(a.type))) ? "—" : <Money cents={liabilities} currency={cur} />}</strong></div>
        <div className="bw-metric bw-metric-accent"><span>{x.netWorth}</span><strong>{onlyUnknown(included) ? "—" : <Money cents={assets - liabilities} currency={cur} />}</strong></div>
      </div>
      {editing && (
        <AccountForm account={editing === "new" ? null : editing} currency={cur} onCancel={() => setEditing(null)} onDone={done} />
      )}
      {adjusting && <AdjustForm account={adjusting} onDone={done} onCancel={() => setAdjusting(null)} />}
      {groups.map((group) => group.items.length > 0 && (
        <section key={group.title} className="bw-panel" aria-label={group.title}>
          <h2>{group.title}</h2>
          <ul className="bw-tx-table bw-account-list">
            {group.items.map((account) => (
              <li key={account.id} className={account.archived ? "is-excluded" : ""}>
                <div className="bw-tx-main">
                  <strong>{account.unassigned ? x.unassigned : account.name}</strong>
                  <small>
                    {m.ledger.accountTypes[account.type]}{account.institution ? ` · ${account.institution}` : ""}{account.last4 ? ` …${account.last4}` : ""}
                    {account.archived ? ` · ${x.archived}` : ""}{!account.includeInNetWorth ? ` · ${x.includeInNetWorth}: ${m.ledger.common.none}` : ""}
                  </small>
                  {account.openingBalanceSource === "statement" && <small className="bw-muted">{x.estimated}</small>}
                  {account.openingBalanceSource === "unknown" && account.entryCount > 0 && <small className="bw-muted">{x.unknownBalance}</small>}
                </div>
                <div className="bw-account-balance">
                  {account.openingBalanceSource === "unknown" ? copy[locale].unknown : isLiability(account.type) ? <><small>{x.owed}</small> <Money cents={-account.balanceCents} currency={account.currency} /></> : <Money cents={account.balanceCents} currency={account.currency} />}
                  {account.openingBalanceSource !== "unknown" && account.creditLimitCents !== null && <small>{x.available}: {formatMoney(account.creditLimitCents + account.balanceCents, account.currency)}</small>}
                </div>
                <div className="bw-row-actions">
                  {!account.archived && <button type="button" className="bw-link-button" onClick={() => setAdjusting(account)}>{x.adjust}</button>}
                  <button type="button" className="bw-link-button" onClick={() => setEditing(account)}>{m.ledger.common.edit}</button>
                  {!account.archived && <button type="button" className="bw-link-button" aria-label={`${m.ledger.common.moveUp}: ${account.name}`} onClick={() => move(account, -1)}>↑</button>}
                  {!account.archived && <button type="button" className="bw-link-button" aria-label={`${m.ledger.common.moveDown}: ${account.name}`} onClick={() => move(account, 1)}>↓</button>}
                  {account.archived
                    ? <button type="button" className="bw-link-button" onClick={() => act(() => store.ledger.setAccountArchived(account.id, false), x.restoredDone)}>{m.ledger.common.unarchive}</button>
                    : <button type="button" className="bw-link-button" onClick={() => act(() => store.ledger.setAccountArchived(account.id, true), x.archivedDone)}>{m.ledger.common.archive}</button>}
                  {account.entryCount === 0 && <button type="button" className="bw-link-button bw-danger" onClick={() => act(() => store.ledger.deleteAccount(account.id), x.deleted)}>{m.ledger.common.delete}</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <label className="bw-check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {m.ledger.common.showArchived}</label>
    </>
  );
}
