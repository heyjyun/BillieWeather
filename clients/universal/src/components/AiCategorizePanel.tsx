// "Categorize with AI": shown on the Categories page and in AI Assistant, so it is reachable whether
// or not the Categories & Tags module is on. Sends cleaned merchant names only, after consent, to the
// BillieWeather server (which holds the AI key); the result is applied locally as ONE audited,
// undoable batch (FinanceStore.applyAiCategoriesBatch → Activity › Undo).
import { AI_BATCH_MAX, type AiGroup } from "@billie/finance-core";
import { useState } from "react";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import { AccountError } from "../services/account";
import { AiCategorizeError, requestAiCategories } from "../services/aiCategorize";

type AiState =
  | { step: "idle" }
  | { step: "consent"; groups: AiGroup[]; batch: AiGroup[]; transactions: number }
  | { step: "working" };

export function AiCategorizePanel({ uncategorized, say }: { uncategorized: number; say: (message: string, isError?: boolean) => void }) {
  const { m, t } = useI18n();
  const { getToken, expire } = useAccount();
  const { customCategories, store, refresh } = useFinance();
  const [ai, setAi] = useState<AiState>({ step: "idle" });
  const x = m.categoryPage;

  async function startAi() {
    say("");
    const groups = await store.aiCandidates();
    const batch = groups.slice(0, AI_BATCH_MAX);
    setAi({ step: "consent", groups, batch, transactions: batch.reduce((sum, group) => sum + group.ids.length, 0) });
  }

  async function runAi(groups: AiGroup[], batch: AiGroup[]) {
    setAi({ step: "working" });
    try {
      const token = getToken();
      if (!token) throw new AccountError("unauthorized");
      const assignments = await requestAiCategories(token, batch.map(({ key, text, direction }) => ({ key, text, direction })), customCategories);
      const { changed } = await store.applyAiCategoriesBatch(batch, assignments);
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
      else throw caught;
    } finally {
      setAi((current) => (current.step === "working" ? { step: "idle" } : current));
    }
  }

  return (
    <section className="bw-panel" aria-labelledby="ai-heading">
      <h2 id="ai-heading">{x.aiTitle}</h2>
      <p>{uncategorized > 0 ? t("categoryPage.aiBody", { count: uncategorized }) : x.aiNone}</p>
      {ai.step === "idle" && <button type="button" className="bw-button bw-button-dark" disabled={uncategorized === 0} onClick={startAi}>{x.aiStart}</button>}
      {ai.step === "working" && <p className="bw-caption" role="status">{x.aiWorking}</p>}
      {ai.step === "consent" && (
        <div className="bw-consent" role="dialog" aria-labelledby="ai-consent-heading">
          <h3 id="ai-consent-heading">{x.aiConsentTitle}</h3>
          <p>{t("categoryPage.aiConsentBody", { merchants: ai.batch.length, count: ai.transactions })}</p>
          <p><strong>{x.aiPreview}</strong></p>
          <ul className="bw-consent-preview">
            {ai.batch.slice(0, 8).map((group) => <li key={group.key}><code>{group.text}</code> <small>({group.direction === "in" ? m.settings.moneyIn : m.settings.moneyOut})</small></li>)}
            {ai.batch.length > 8 && <li>{t("categoryPage.aiPreviewMore", { count: ai.batch.length - 8 })}</li>}
            {customCategories.length > 0 && <li>{x.customTitle}: {customCategories.join(", ")}</li>}
          </ul>
          <p className="bw-caption">{x.aiNotSent}</p>
          <div className="bw-db-actions">
            <button type="button" className="bw-button bw-button-dark" disabled={ai.batch.length === 0} onClick={() => runAi(ai.groups, ai.batch)}>{x.aiConfirm}</button>
            <button type="button" className="bw-link-button" onClick={() => setAi({ step: "idle" })}>{x.cancel}</button>
          </div>
        </div>
      )}
      <p className="bw-caption">{x.aiNote}</p>
    </section>
  );
}
