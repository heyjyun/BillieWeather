// Accounts (账户): every place money is, grouped into assets and liabilities, with balances and net
// worth. Create, edit, reorder, archive / restore, delete an unused account, and record the real
// balance (余额) as one adjustment entry.
import { ACCOUNT_TYPES, formatMoney, isLiability, type AccountType } from "@billie/finance-core";
import { CURRENCIES } from "@billie/shared-types";
import { useState, type FormEvent } from "react";
import { useDraftState, useMode } from "../hooks/useMode";
import { currencyOptions, SearchableSelect } from "../components/SearchableSelect";
import { Empty, Money, PageHeading } from "../components/common";
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
  const { m } = useI18n();
  const x = m.ledger.accounts;
  const { store, refresh } = useFinance();
  const [name, setName] = useDraftState(draftKey, "name", account?.name ?? "");
  const [type, setType] = useDraftState<AccountType>(draftKey, "type", account?.type ?? "checking");
  const [institution, setInstitution] = useDraftState(draftKey, "institution", account?.institution ?? "");
  const [last4, setLast4] = useDraftState(draftKey, "last4", account?.last4 ?? "");
  const [opening, setOpening] = useDraftState(draftKey, "opening", account ? (account.openingBalanceCents / 100).toFixed(2) : "0.00");
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
    if (openingCents === null || (limit.trim() && limitCents === null)) return setError(m.ledger.problems.amount_required);
    const day = (text: string) => (text.trim() ? Math.min(31, Math.max(1, Math.trunc(Number(text)))) : null);
    const input: AccountInput = {
      name, type, institution: institution || null, last4: last4 || null, openingBalanceCents: openingCents, openingBalanceOn: openingOn || null,
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
        <label className="bw-field"><span>{x.name}</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></label>
        <label className="bw-field">
          <span>{x.type}</span>
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {ACCOUNT_TYPES.map((option) => <option key={option} value={option}>{m.ledger.accountTypes[option]}</option>)}
          </select>
        </label>
        <label className="bw-field"><span>{x.institution} <small>({m.ledger.common.optional})</small></span><input value={institution} onChange={(e) => setInstitution(e.target.value)} maxLength={60} /></label>
        <label className="bw-field"><span>{x.last4} <small>({m.ledger.common.optional})</small></span><input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" /></label>
        <label className="bw-field"><span>{x.openingBalance}</span><input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} /><small>{x.openingBalanceHelp}</small></label>
        <label className="bw-field"><span>{x.openingOn} <small>({m.ledger.common.optional})</small></span><input type="date" value={openingOn} onChange={(e) => setOpeningOn(e.target.value)} /></label>
        {isLiability(type) && <label className="bw-field"><span>{x.creditLimit} <small>({m.ledger.common.optional})</small></span><input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>}
        {type === "credit_card" && <label className="bw-field"><span>{x.statementDay} <small>({m.ledger.common.optional})</small></span><input type="number" min={1} max={31} value={statementDay} onChange={(e) => setStatementDay(e.target.value)} /></label>}
        {isLiability(type) && <label className="bw-field"><span>{x.dueDay} <small>({m.ledger.common.optional})</small></span><input type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} /></label>}
        <label className="bw-check"><input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> {x.includeInNetWorth}</label>
        <label className="bw-field bw-grow"><span>{x.note} <small>({m.ledger.common.optional})</small></span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
      </div>
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
      <div className="bw-actions">
        <button type="submit" className="bw-button bw-button-dark">{m.ledger.common.save}</button>
        <button type="button" className="bw-button bw-button-outline" onClick={onCancel}>{m.ledger.common.cancel}</button>
      </div>
    </form>
  );
}

function AdjustForm({ account, onDone, onCancel }: { account: Account; onDone: (message: string) => void; onCancel: () => void }) {
  const { m, t } = useI18n();
  const x = m.ledger.accounts;
  const { store, refresh } = useFinance();
  const [target, setTarget] = useState((account.balanceCents / 100).toFixed(2));
  const [date, setDate] = useState(today());
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parseAmount(target, true);
    if (cents === null) return setError(m.ledger.problems.amount_required);
    const before = account.balanceCents;
    const id = await store.ledger.adjustBalance(account.id, cents, date);
    await refresh();
    onDone(id === null ? x.adjustNone : t("ledger.accounts.adjustDone", { amount: formatMoney(cents - before, account.currency) }));
  }
  return (
    <form className="bw-panel bw-entry-form" aria-label={x.adjustTitle} onSubmit={submit}>
      <h2>{x.adjustTitle}: {account.name}</h2>
      <p className="bw-caption">{x.adjustHelp}</p>
      <div className="bw-form-grid">
        <label className="bw-field"><span>{x.actualBalance}</span><input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
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

export function Accounts() {
  const { m } = useI18n();
  const x = m.ledger.accounts;
  const { store, accounts, currency, refresh } = useFinance();
  // Which form is open is part of the draft too, so it reopens after a mode switch.
  const [editing, setEditing] = useDraftState<Account | "new" | null>("accounts-page", "editing", null);
  const [adjusting, setAdjusting] = useState<Account | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [status, setStatus] = useState("");
  const [bookCurrency, setBookCurrency] = useState("USD");
  const visible = accounts.filter((account) => showArchived || !account.archived);
  const live = accounts.filter((account) => !account.archived && account.includeInNetWorth);
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
        <button type="button" className="bw-button bw-button-dark" onClick={() => setEditing("new")}>{x.add}</button>
      </PageHeading>
      <p className="bw-caption">{x.intro}</p>
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
      <div className="bw-metrics">
        <div className="bw-metric"><span>{x.assets}</span><strong><Money cents={assets} currency={cur} /></strong></div>
        <div className="bw-metric"><span>{x.liabilities}</span><strong><Money cents={liabilities} currency={cur} /></strong></div>
        <div className="bw-metric bw-metric-accent"><span>{x.netWorth}</span><strong><Money cents={assets - liabilities} currency={cur} /></strong></div>
      </div>
      {editing && (
        <AccountForm account={editing === "new" ? null : editing} currency={cur} onCancel={() => setEditing(null)} onDone={done} />
      )}
      {adjusting && <AdjustForm account={adjusting} onDone={done} onCancel={() => setAdjusting(null)} />}
      {accounts.length === 0 ? <Empty title={x.empty} body={x.emptyBody} /> : groups.map((group) => group.items.length > 0 && (
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
                  {isLiability(account.type) ? <><small>{x.owed}</small> <Money cents={-account.balanceCents} currency={account.currency} /></> : <Money cents={account.balanceCents} currency={account.currency} />}
                  {account.creditLimitCents !== null && <small>{x.available}: {formatMoney(account.creditLimitCents + account.balanceCents, account.currency)}</small>}
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
