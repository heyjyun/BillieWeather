// Budgets (预算) and recurring entries (周期记账), plus the custom month start day.
import { formatMoney, FREQUENCIES, type Frequency, type TransactionKind } from "@billie/finance-core";
import { allCategories } from "@billie/finance-core";
import { useEffect, useState, type FormEvent } from "react";
import { useDraftState } from "../hooks/useMode";
import { categoryChoices, indented, Money, PageHeading } from "../components/common";
import { parseAmount } from "../components/EntryForm";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { LedgerError, type Budget, type Dimension, type RecurringRule } from "../services/ledger";

const today = () => new Date().toISOString().slice(0, 10);

/** `focus: "schedules"` opens on the recurring section (Recurring & Bills in the Feature Library). */
export function Planning({ focus = null }: { focus?: string | null } = {}) {
  const { m, t } = useI18n();
  const x = m.ledger.planning;
  const { store, accounts, customCategories, categoryTree, currency, refresh, transactions } = useFinance();
  const cur = currency ?? accounts[0]?.currency ?? "USD";
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [projects, setProjects] = useState<Dimension[]>([]);
  const [due, setDue] = useState(0);
  const [monthStart, setMonthStart] = useState(1);
  const [status, setStatus] = useState("");
  // Unsaved budget and schedule forms are drafts, kept across a mode switch.
  const [budgetForm, setBudgetForm] = useDraftState("planning-page", "budget", { period: "month" as "month" | "year", scope: "", amount: focus?.startsWith("budget-") && /^\d+$/.test(focus.slice(7)) ? (Number(focus.slice(7)) / 100).toFixed(2) : "", alert: "90" });
  const [ruleForm, setRuleForm] = useDraftState<null | { id?: number; name: string; kind: TransactionKind; amount: string; accountId: string; toAccountId: string; category: string; frequency: Frequency; interval: string; startOn: string; endOn: string; autoPost: boolean }>("planning-page", "schedule", null);
  const live = accounts.filter((a) => !a.archived && !a.unassigned);
  const categories = allCategories(customCategories).filter((c) => categoryTree.kindOf(c) !== "transfer");
  // Pickers show the tree, indented, without hidden categories.
  const choices = (names: readonly string[], value?: string | null) => categoryChoices(categoryTree, names, value);

  const reload = async () => {
    setBudgets(await store.ledger.budgets());
    setRules(await store.ledger.recurringRules());
    setProjects(await store.ledger.dimensions("project"));
    setDue((await store.ledger.dueOccurrences()).length);
    setMonthStart(await store.ledger.monthStartDay());
  };
  useEffect(() => { void reload(); }, [store, transactions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (focus === "schedules") document.getElementById("schedules-heading")?.scrollIntoView?.({ block: "start" });
  }, [focus]);

  async function act(action: () => Promise<unknown>, message = m.ledger.common.saved) {
    try {
      await action();
      await refresh();
      await reload();
      setStatus(message);
    } catch (caught) {
      setStatus(caught instanceof LedgerError ? m.ledger.errors[caught.code] ?? m.ledger.errors.unknown : m.ledger.errors.unknown);
    }
  }

  async function addBudget(event: FormEvent) {
    event.preventDefault();
    const cents = parseAmount(budgetForm.amount);
    if (!cents) return setStatus(m.ledger.problems.amount_required);
    const [kind, value] = budgetForm.scope.split(":");
    await act(() => store.ledger.saveBudget({ period: budgetForm.period, category: kind === "c" ? value : null, projectId: kind === "p" ? Number(value) : null, amountCents: cents, alertPercent: Number(budgetForm.alert) || 90 }));
    setBudgetForm({ ...budgetForm, amount: "" });
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    if (!ruleForm) return;
    const cents = parseAmount(ruleForm.amount);
    if (!cents) return setStatus(m.ledger.problems.amount_required);
    await act(() => store.ledger.saveRecurringRule({
      id: ruleForm.id, name: ruleForm.name, frequency: ruleForm.frequency, interval: Number(ruleForm.interval) || 1, startOn: ruleForm.startOn, endOn: ruleForm.endOn || null, autoPost: ruleForm.autoPost,
      template: { kind: ruleForm.kind, amountCents: cents, accountId: Number(ruleForm.accountId), toAccountId: ruleForm.kind === "transfer" ? Number(ruleForm.toAccountId) : null, category: ruleForm.kind === "transfer" ? null : ruleForm.category || null, description: ruleForm.name },
    }));
    setRuleForm(null);
  }

  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      {status && <p className="bw-message bw-message-ok">{status}</p>}
      <section className="bw-panel" aria-labelledby="budgets-heading">
        <h2 id="budgets-heading">{x.budgets}</h2>
        <p className="bw-caption">{x.budgetsIntro}</p>
        <label className="bw-field">
          <span>{x.monthStart}</span>
          <input type="number" min={1} max={28} value={monthStart} onChange={(e) => setMonthStart(Number(e.target.value))} onBlur={() => act(() => store.ledger.setMonthStartDay(Math.min(28, Math.max(1, monthStart))))} />
          <small>{x.monthStartHelp}</small>
        </label>
        {budgets.length === 0 ? <p>{x.noBudgets}</p> : (
          <ul className="bw-tx-table">
            {budgets.map((budget) => (
              <li key={budget.id}>
                <div className="bw-tx-main">
                  <strong>{budget.category ? categoryLabel(m, budget.category) : budget.projectName ?? x.everything}</strong>
                  <small>{budget.period === "month" ? x.month : x.year} · {t("ledger.planning.periodRange", { from: budget.from, to: budget.to })}</small>
                  <div className="bw-usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(budget.status.ratio * 100))} aria-label={t("ledger.planning.spent", { spent: formatMoney(budget.status.spentMinor, cur), limit: formatMoney(budget.amountCents, cur) })}>
                    <span className={budget.status.level === "over" ? "bw-usage-5" : budget.status.level === "warning" ? "bw-usage-3" : "bw-usage-1"} style={{ width: `${Math.min(100, budget.status.ratio * 100)}%` }} />
                  </div>
                  <small className={budget.status.level === "ok" ? "" : "bw-negative"}>
                    {t("ledger.planning.spent", { spent: formatMoney(budget.status.spentMinor, cur), limit: formatMoney(budget.amountCents, cur) })} · {budget.status.remainingMinor >= 0 ? t("ledger.planning.left", { amount: formatMoney(budget.status.remainingMinor, cur) }) : t("ledger.planning.over", { amount: formatMoney(-budget.status.remainingMinor, cur) })}
                  </small>
                </div>
                <button type="button" className="bw-link-button bw-danger" onClick={() => act(() => store.ledger.deleteBudget(budget.id))}>{m.ledger.common.delete}</button>
              </li>
            ))}
          </ul>
        )}
        <form className="bw-form-grid" aria-label={x.addBudget} onSubmit={addBudget}>
          <label className="bw-field"><span>{x.period}</span>
            <select value={budgetForm.period} onChange={(e) => setBudgetForm({ ...budgetForm, period: e.target.value as "month" | "year" })}><option value="month">{x.month}</option><option value="year">{x.year}</option></select>
          </label>
          <label className="bw-field"><span>{x.scope}</span>
            <select value={budgetForm.scope} onChange={(e) => setBudgetForm({ ...budgetForm, scope: e.target.value })}>
              <option value="">{x.everything}</option>
              <optgroup label={m.ledger.entry.category}>{choices(categories.filter((c) => categoryTree.kindOf(c) !== "income")).map((c) => <option key={c.name} value={`c:${c.name}`}>{indented(categoryLabel(m, c.name), c.depth)}</option>)}</optgroup>
              {projects.length > 0 && <optgroup label={m.ledger.entry.project}>{projects.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}</optgroup>}
            </select>
          </label>
          <label className="bw-field"><span>{m.ledger.entry.amount}</span><input inputMode="decimal" value={budgetForm.amount} onChange={(e) => setBudgetForm({ ...budgetForm, amount: e.target.value })} required /></label>
          <label className="bw-field"><span>{x.alert}</span><input type="number" min={1} max={100} value={budgetForm.alert} onChange={(e) => setBudgetForm({ ...budgetForm, alert: e.target.value })} /></label>
          <button type="submit" className="bw-button">{x.addBudget}</button>
        </form>
      </section>

      <section className="bw-panel bw-section-gap" aria-labelledby="schedules-heading">
        <h2 id="schedules-heading">{x.schedules}</h2>
        <p className="bw-caption">{x.schedulesIntro}</p>
        <div className="bw-actions">
          <button type="button" className="bw-button bw-button-dark" onClick={() => setRuleForm({ name: "", kind: "expense", amount: "", accountId: String(live[0]?.id ?? ""), toAccountId: "", category: "", frequency: "monthly", interval: "1", startOn: today(), endOn: "", autoPost: false })}>{x.addSchedule}</button>
          {due > 0 && <button type="button" className="bw-button" onClick={async () => { let count = 0; await act(async () => { count = await store.ledger.postDue(); }); setStatus(t("ledger.planning.posted", { count })); }}>{t("ledger.planning.postDue", { count: due })}</button>}
        </div>
        {ruleForm && (
          <form className="bw-panel bw-entry-form" aria-label={x.addSchedule} onSubmit={saveRule}>
            <div className="bw-form-grid">
              <label className="bw-field"><span>{x.name}</span><input value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} required maxLength={60} /></label>
              <label className="bw-field"><span>{m.ledger.entry.type}</span>
                <select value={ruleForm.kind} onChange={(e) => setRuleForm({ ...ruleForm, kind: e.target.value as TransactionKind })}>
                  {(["expense", "income", "transfer"] as TransactionKind[]).map((k) => <option key={k} value={k}>{m.ledger.kinds[k]}</option>)}
                </select>
              </label>
              <label className="bw-field"><span>{m.ledger.entry.amount}</span><input inputMode="decimal" value={ruleForm.amount} onChange={(e) => setRuleForm({ ...ruleForm, amount: e.target.value })} required /></label>
              <label className="bw-field"><span>{ruleForm.kind === "transfer" ? m.ledger.entry.from : m.ledger.entry.account}</span>
                <select value={ruleForm.accountId} onChange={(e) => setRuleForm({ ...ruleForm, accountId: e.target.value })}>{live.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              </label>
              {ruleForm.kind === "transfer" ? (
                <label className="bw-field"><span>{m.ledger.entry.to}</span>
                  <select value={ruleForm.toAccountId} onChange={(e) => setRuleForm({ ...ruleForm, toAccountId: e.target.value })}><option value="">—</option>{live.filter((a) => String(a.id) !== ruleForm.accountId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                </label>
              ) : (
                <label className="bw-field"><span>{m.ledger.entry.category}</span>
                  <select value={ruleForm.category} onChange={(e) => setRuleForm({ ...ruleForm, category: e.target.value })}>
                    <option value="">—</option>{choices(categories.filter((c) => ruleForm.kind === "income" || categoryTree.kindOf(c) !== "income"), ruleForm.category).map((c) => <option key={c.name} value={c.name}>{indented(categoryLabel(m, c.name), c.depth)}</option>)}
                  </select>
                </label>
              )}
              <label className="bw-field"><span>{x.frequency}</span>
                <select value={ruleForm.frequency} onChange={(e) => setRuleForm({ ...ruleForm, frequency: e.target.value as Frequency })}>{FREQUENCIES.map((f) => <option key={f} value={f}>{x.frequencies[f]}</option>)}</select>
              </label>
              <label className="bw-field"><span>{x.every}</span><input type="number" min={1} max={365} value={ruleForm.interval} onChange={(e) => setRuleForm({ ...ruleForm, interval: e.target.value })} /></label>
              <label className="bw-field"><span>{x.startOn}</span><input type="date" value={ruleForm.startOn} onChange={(e) => setRuleForm({ ...ruleForm, startOn: e.target.value })} required /></label>
              <label className="bw-field"><span>{x.endOn} <small>({m.ledger.common.optional})</small></span><input type="date" value={ruleForm.endOn} onChange={(e) => setRuleForm({ ...ruleForm, endOn: e.target.value })} /></label>
              <label className="bw-check"><input type="checkbox" checked={ruleForm.autoPost} onChange={(e) => setRuleForm({ ...ruleForm, autoPost: e.target.checked })} /> {x.autoPost}</label>
            </div>
            <p className="bw-caption">{t("ledger.planning.preview", { dates: store.ledger.previewOccurrences(ruleForm.startOn, ruleForm.frequency, Number(ruleForm.interval) || 1, 4, ruleForm.endOn || null).join(", ") })}</p>
            <div className="bw-actions">
              <button type="submit" className="bw-button bw-button-dark">{m.ledger.common.save}</button>
              <button type="button" className="bw-button bw-button-outline" onClick={() => setRuleForm(null)}>{m.ledger.common.cancel}</button>
            </div>
          </form>
        )}
        {rules.length === 0 ? <p>{x.noSchedules}</p> : (
          <ul className="bw-tx-table">
            {rules.map((rule) => (
              <li key={rule.id} className={rule.paused ? "is-excluded" : ""}>
                <div className="bw-tx-main">
                  <strong>{rule.name}</strong>
                  <small>{m.ledger.kinds[rule.template.kind]} · {x.frequencies[rule.frequency]}{rule.interval > 1 ? ` ×${rule.interval}` : ""} · {rule.paused ? x.paused : rule.nextOn ? t("ledger.planning.next", { date: rule.nextOn }) : x.ended}{rule.autoPost ? ` · ${x.autoPost}` : ""}</small>
                </div>
                <Money cents={rule.template.kind === "income" ? rule.template.amountCents : -rule.template.amountCents} currency={cur} signed />
                <div className="bw-row-actions">
                  <button type="button" className="bw-link-button" onClick={() => setRuleForm({ id: rule.id, name: rule.name, kind: rule.template.kind, amount: (rule.template.amountCents / 100).toFixed(2), accountId: String(rule.template.accountId), toAccountId: String(rule.template.toAccountId ?? ""), category: rule.template.category ?? "", frequency: rule.frequency, interval: String(rule.interval), startOn: rule.startOn, endOn: rule.endOn ?? "", autoPost: rule.autoPost })}>{m.ledger.common.edit}</button>
                  <button type="button" className="bw-link-button" onClick={() => act(() => store.ledger.setRecurringPaused(rule.id, !rule.paused))}>{rule.paused ? x.resume : x.pause}</button>
                  {!rule.paused && rule.nextOn && <button type="button" className="bw-link-button" onClick={() => act(() => store.ledger.skipOccurrence(rule.id))}>{x.skip}</button>}
                  <button type="button" className="bw-link-button bw-danger" onClick={() => act(() => store.ledger.deleteRecurringRule(rule.id))}>{m.ledger.common.delete}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
