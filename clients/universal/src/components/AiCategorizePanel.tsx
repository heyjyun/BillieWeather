// "Categorize with AI": shown on the Categories page and in AI Assistant, so it is reachable whether
// or not the Categories & Tags module is on. Sends cleaned merchant names only, after consent, to the
// BillieWeather server (which holds the AI key); the result is applied locally as ONE audited,
// undoable batch (FinanceStore.applyAiCategoriesBatch → Activity › Undo). Categories are sent as full
// paths. New subcategories the AI proposes are only listed here: each is created (with the name the
// person may edit) only when they approve it, together with filing its merchants, as one undoable step.
import { AI_BATCH_MAX, aiCategoryPaths, parseAiProposals, type AiGroup, type AiProposal } from "@billie/finance-core";
import { useState } from "react";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { InlineDialog } from "./common";
import { StoreError } from "../services/store";
import { AccountError } from "../services/account";
import { AiCategorizeError, requestAiCategories } from "../services/aiCategorize";

type AiState =
  | { step: "idle" }
  | { step: "consent"; groups: AiGroup[]; batch: AiGroup[]; transactions: number }
  | { step: "working" };

export function AiCategorizePanel({ uncategorized, say }: { uncategorized: number; say: (message: string, isError?: boolean) => void }) {
  const { m, t } = useI18n();
  const { getToken, expire } = useAccount();
  const { categoryTree, store, refresh } = useFinance();
  const [ai, setAi] = useState<AiState>({ step: "idle" });
  // Proposals from the last answer, with the name the person may edit, and the groups they refer to.
  const [proposals, setProposals] = useState<Array<AiProposal & { edited: string }>>([]);
  const [proposalGroups, setProposalGroups] = useState<AiGroup[]>([]);
  const paths = aiCategoryPaths(categoryTree);
  const x = m.categoryPage;

  async function startAi() {
    say("");
    let groups: AiGroup[];
    try {
      groups = await store.aiCandidates();
    } catch {
      say(x.aiErrorFailed, true); // the local book could not be read; nothing was sent or changed
      return;
    }
    const batch = groups.slice(0, AI_BATCH_MAX);
    setAi({ step: "consent", groups, batch, transactions: batch.reduce((sum, group) => sum + group.ids.length, 0) });
  }

  async function runAi(groups: AiGroup[], batch: AiGroup[]) {
    setAi({ step: "working" });
    try {
      const token = getToken();
      if (!token) throw new AccountError("unauthorized");
      const assignments = await requestAiCategories(token, batch.map(({ key, text, direction }) => ({ key, text, direction })), paths);
      const { changed } = await store.applyAiCategoriesBatch(batch, assignments);
      // Groups the batch just filed are no longer candidates for a proposal.
      const filed = new Set(assignments.map((assignment) => assignment.key));
      const offered = parseAiProposals(assignments.proposals, categoryTree, batch.map((group) => group.key))
        .map((proposal) => ({ ...proposal, keys: proposal.keys.filter((key) => !filed.has(key)) }))
        .filter((proposal) => proposal.keys.length > 0);
      setProposals(offered.map((proposal) => ({ ...proposal, edited: proposal.name })));
      setProposalGroups(batch);
      await refresh();
      const remaining = groups.length - batch.length;
      say([t("categoryPage.aiDone", { count: changed, sent: batch.length }), remaining > 0 ? t("categoryPage.aiRemaining", { count: remaining }) : ""].filter(Boolean).join(" "));
    } catch (caught) {
      if (caught instanceof AccountError && caught.code === "unauthorized") {
        await expire();
        return;
      }
      if (caught instanceof AccountError) say(x.aiErrorOffline, true);
      else if (caught instanceof AiCategorizeError) say(caught.code === "wait" ? x.aiErrorWait : caught.code === "not_configured" ? x.aiErrorNotConfigured : x.aiErrorFailed, true);
      // Anything else (e.g. the local database refusing the batch, which is written atomically): say so
      // instead of leaving an unhandled rejection and a silent panel.
      else say(x.aiErrorFailed, true);
    } finally {
      setAi((current) => (current.step === "working" ? { step: "idle" } : current));
    }
  }

  async function approve(proposal: AiProposal & { edited: string }) {
    say("");
    try {
      const { name, changed } = await store.approveAiProposal(proposalGroups, proposal, proposal.edited);
      setProposals((current) => current.filter((item) => item !== proposal));
      await refresh();
      say(t("categoryPage.proposalApproved", { name, count: changed }));
    } catch (caught) {
      const problem = caught instanceof StoreError && caught.code === "invalid_category" ? String(caught.vars.problem) : null;
      say(problem === "taken" ? x.errorTaken : problem === "too_long" ? t("categoryPage.errorTooLong", { max: 40 }) : problem ? x.errorBlank : x.aiErrorFailed, true);
    }
  }

  const examples = (proposal: AiProposal) => proposal.keys.map((key) => proposalGroups.find((group) => group.key === key)?.text).filter(Boolean).slice(0, 3).join(", ");

  return (
    <section className="bw-panel" aria-labelledby="ai-heading">
      <h2 id="ai-heading">{x.aiTitle}</h2>
      <p>{uncategorized > 0 ? t("categoryPage.aiBody", { count: uncategorized }) : x.aiNone}</p>
      {ai.step === "idle" && <button type="button" className="bw-button bw-button-dark" disabled={uncategorized === 0} onClick={startAi}>{x.aiStart}</button>}
      {ai.step === "working" && <p className="bw-caption" role="status">{x.aiWorking}</p>}
      {ai.step === "consent" && (
        <InlineDialog className="bw-consent" label={x.aiConsentTitle} onCancel={() => setAi({ step: "idle" })}>
          <h3>{x.aiConsentTitle}</h3>
          <p>{t("categoryPage.aiConsentBody", { merchants: ai.batch.length, count: ai.transactions })}</p>
          <p><strong>{x.aiPreview}</strong></p>
          <ul className="bw-consent-preview">
            {ai.batch.slice(0, 8).map((group) => <li key={group.key}><code>{group.text}</code> <small>({group.direction === "in" ? m.settings.moneyIn : m.settings.moneyOut})</small></li>)}
            {ai.batch.length > 8 && <li>{t("categoryPage.aiPreviewMore", { count: ai.batch.length - 8 })}</li>}
            {paths.length > 0 && <li>{x.customTitle}: {paths.join(", ")}</li>}
          </ul>
          <p className="bw-caption">{x.aiNotSent}</p>
          <div className="bw-db-actions">
            <button type="button" className="bw-button bw-button-dark" disabled={ai.batch.length === 0} onClick={() => runAi(ai.groups, ai.batch)}>{x.aiConfirm}</button>
            <button type="button" className="bw-link-button" onClick={() => setAi({ step: "idle" })}>{x.cancel}</button>
          </div>
        </InlineDialog>
      )}
      {proposals.length > 0 && (
        <div className="bw-ai-proposals" role="region" aria-labelledby="ai-proposals-heading">
          <h3 id="ai-proposals-heading">{x.proposalsTitle}</h3>
          <p className="bw-caption">{x.proposalsBody}</p>
          <ul className="bw-tx-table">
            {proposals.map((proposal) => (
              <li key={`${proposal.parent}/${proposal.name}`}>
                <div className="bw-tx-main">
                  <label className="bw-field">
                    <span>{t("categoryPage.proposalName", { parent: categoryLabel(m, proposal.parent) })}</span>
                    <input value={proposal.edited} maxLength={40} onChange={(e) => setProposals((current) => current.map((item) => (item === proposal ? { ...item, edited: e.target.value } : item)))} />
                  </label>
                  <small>{t("categoryPage.proposalUnder", { parent: categoryTree.path(proposal.parent, (name) => categoryLabel(m, name)) })} · {t("categoryPage.proposalFits", { count: proposal.keys.length, examples: examples(proposal) })}</small>
                </div>
                <div className="bw-row-actions">
                  <button type="button" className="bw-button" disabled={!proposal.edited.trim()} onClick={() => approve(proposal)}>{x.proposalApprove}</button>
                  <button type="button" className="bw-link-button" onClick={() => setProposals((current) => current.filter((item) => item !== proposal))}>{x.proposalDismiss}</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="bw-caption">{x.aiNote}</p>
    </section>
  );
}
