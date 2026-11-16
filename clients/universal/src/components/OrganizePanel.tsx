// "Organize my finances": Analyze -> Preview -> Review -> Approve -> Apply -> Undo. Nothing changes
// until the person approves; applied changes are one batch in the activity log and can be undone.
import { formatMoney, type Proposal } from "@billie/finance-core";
import { useMemo, useState } from "react";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { requestAiCategories } from "../services/aiCategorize";
import { analyze, applyProposals, undoRun } from "../services/organize";

type Step = { step: "idle" } | { step: "working" } | { step: "review"; runId: string; proposals: Proposal[] } | { step: "applied"; batchId: string; applied: number } | { step: "undone" };

export function OrganizePanel({ onClose }: { onClose: () => void }) {
  const { m, t } = useI18n();
  const x = m.ledger.organize;
  const { store, transactions, currency, refresh, persistent } = useFinance();
  const { getToken } = useAccount();
  const [cloud, setCloud] = useState(false);
  const [remember, setRemember] = useState(false);
  const [state, setState] = useState<Step>({ step: "idle" });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const cur = currency ?? "USD";
  const byId = useMemo(() => new Map(transactions.map((tx) => [tx.id, tx])), [transactions]);
  const name = (id: number) => byId.get(id)?.description ?? `#${id}`;

  async function run() {
    setError("");
    setState({ step: "working" });
    try {
      const token = getToken();
      const result = await analyze(store, store.sql, cloud && token ? { cloud: (items, custom) => requestAiCategories(token, items, custom) } : {});
      setChosen(new Set(result.proposals.filter((p) => p.type !== "recurring" && p.confidence >= 70).map((p) => p.id)));
      setState({ step: "review", ...result });
    } catch {
      setError(m.ledger.errors.unknown);
      setState({ step: "idle" });
    }
  }

  const describe = (p: Proposal): string => {
    switch (p.type) {
      case "categorize": return t("ledger.organize.describe.categorize", { description: `${p.description}${p.ids.length > 1 ? ` (×${p.ids.length})` : ""}`, category: categoryLabel(m, p.category) });
      case "transfer": case "card_payment": return t("ledger.organize.describe.transfer", { from: name(p.outId), to: name(p.inId), amount: formatMoney(p.amountMinor, cur) });
      case "refund": return t("ledger.organize.describe.refund", { refund: name(p.refundId), original: name(p.expenseId) });
      case "duplicate": return t("ledger.organize.describe.duplicate", { description: name(p.duplicateId), date: byId.get(p.duplicateId)?.bookedOn ?? "" });
      case "recurring": return t("ledger.organize.describe.recurring", { description: p.merchant, days: p.cadenceDays, amount: formatMoney(p.amountMinor, cur) });
      case "merchant": return t("ledger.organize.describe.merchant", { description: `${p.description}${p.ids.length > 1 ? ` (×${p.ids.length})` : ""}`, merchant: p.merchant });
      case "suspect_income": return t("ledger.organize.describe.suspect_income", { description: name(p.entryId), kind: m.ledger.kinds[p.kind] });
    }
  };

  return (
    <section className="bw-panel" aria-labelledby="organize-heading">
      <h2 id="organize-heading">{x.title}</h2>
      <p className="bw-caption">{x.intro}</p>
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
      {(state.step === "idle" || state.step === "undone") && (
        <>
          {state.step === "undone" && <p className="bw-message bw-message-ok" role="status">{x.undone}</p>}
          <label className="bw-check"><input type="radio" name="engine" checked={!cloud} onChange={() => setCloud(false)} /> {x.engineLocal}</label>
          <label className="bw-check"><input type="radio" name="engine" checked={cloud} disabled={!persistent && !getToken()} onChange={() => setCloud(true)} /> {x.engineCloud}</label>
          {cloud && <p className="bw-caption">{x.cloudConsent}</p>}
          <div className="bw-actions">
            <button type="button" className="bw-button bw-button-dark" onClick={run}>{x.analyze}</button>
            <button type="button" className="bw-link-button" onClick={onClose}>{m.ledger.common.close}</button>
          </div>
        </>
      )}
      {state.step === "working" && <p role="status">{x.analyzing}</p>}
      {state.step === "review" && (
        state.proposals.length === 0 ? <><p role="status">{x.nothing}</p><button type="button" className="bw-link-button" onClick={onClose}>{m.ledger.common.close}</button></> : (
          <>
            <p role="status"><strong>{t("ledger.organize.found", { count: state.proposals.length })}</strong></p>
            <label className="bw-check"><input type="checkbox" checked={chosen.size === state.proposals.filter((p) => p.type !== "recurring").length} onChange={(e) => setChosen(e.target.checked ? new Set(state.proposals.filter((p) => p.type !== "recurring").map((p) => p.id)) : new Set())} /> {x.selectAll}</label>
            <ul className="bw-tx-table bw-organize-list">
              {state.proposals.map((p) => (
                <li key={p.id}>
                  {p.type === "recurring"
                    ? <span className="bw-tag bw-tag-muted">{x.kinds.recurring}</span>
                    : <input type="checkbox" aria-label={describe(p)} checked={chosen.has(p.id)} onChange={() => setChosen((was) => { const next = new Set(was); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next; })} />}
                  <div className="bw-tx-main">
                    <strong>{x.kinds[p.type]}</strong>
                    <small>{describe(p)}</small>
                    <small className="bw-muted">{t("ledger.organize.reason", { reason: x.reasons[p.reason] })} · {t("ledger.organize.confidence", { percent: p.confidence })}</small>
                  </div>
                </li>
              ))}
            </ul>
            <label className="bw-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {x.autoRules}</label>
            <div className="bw-actions">
              <button type="button" className="bw-button bw-button-dark" disabled={chosen.size === 0} onClick={async () => {
                const approved = state.proposals.filter((p) => chosen.has(p.id));
                const result = await applyProposals(store, store.sql, state.runId, approved, { rememberCategories: remember });
                await refresh();
                setState({ step: "applied", ...result });
              }}>{t("ledger.organize.apply", { count: chosen.size })}</button>
              <button type="button" className="bw-link-button" onClick={() => setState({ step: "idle" })}>{x.discard}</button>
            </div>
          </>
        )
      )}
      {state.step === "applied" && (
        <>
          <p className="bw-message bw-message-ok" role="status">{t("ledger.organize.applied", { count: state.applied })}</p>
          <div className="bw-actions">
            <button type="button" className="bw-button bw-button-outline" onClick={async () => { await undoRun(store, store.sql, state.batchId); await refresh(); setState({ step: "undone" }); }}>{x.undo}</button>
            <button type="button" className="bw-link-button" onClick={onClose}>{m.ledger.common.close}</button>
          </div>
        </>
      )}
    </section>
  );
}
