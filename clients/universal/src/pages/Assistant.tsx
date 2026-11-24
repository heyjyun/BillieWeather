// AI Assistant in the apps: what works here today — plain-language commands (packages/nl-action-engine,
// offline, previewed and undoable) and "Categorize with AI" (consented, applied as one undoable batch).
// Written insights, tax preparation and chat run on the website; this page says so instead of
// showing a chat that does not exist in the app.
import { useMemo, useState } from "react";
import { PageHeading } from "../components/common";
import { AiCategorizePanel } from "../components/AiCategorizePanel";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import { websiteUrl } from "../services/account";
import { openExternal } from "../services/session";

export function Assistant() {
  const { m, locale } = useI18n();
  const { transactions } = useFinance();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const x = m.modules.assistant;
  const uncategorized = useMemo(() => transactions.filter((transaction) => transaction.category === "Uncategorized").length, [transactions]);
  const say = (message: string, isError = false) => { setStatus(isError ? "" : message); setError(isError ? message : ""); };
  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <p className="bw-muted">{x.intro}</p>
      {status && <p className="bw-message bw-message-ok" role="status">{status}</p>}
      {error && <p className="bw-message bw-message-error" role="alert">{error}</p>}
      <div className="bw-db-grid">
        <section className="bw-panel" aria-labelledby="assistant-commands-heading" id="assistant-commands">
          <h2 id="assistant-commands-heading">{x.commandsTitle}</h2>
          <p>{x.commandsBody}</p>
        </section>
        <AiCategorizePanel uncategorized={uncategorized} say={say} />
        <section className="bw-panel" aria-labelledby="assistant-insights-heading" id="assistant-insights">
          <h2 id="assistant-insights-heading">{x.insightsTitle}</h2>
          <p>{x.insightsBody}</p>
          <button type="button" className="bw-link-button" onClick={() => openExternal(websiteUrl("/app/insights", locale))}>{x.insightsOpen} ↗</button>
        </section>
      </div>
    </>
  );
}
