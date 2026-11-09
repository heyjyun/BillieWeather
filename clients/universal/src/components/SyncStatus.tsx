import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";

/** One line at the top of the app: the result of the latest website-data check. */
export function SyncStatus() {
  const { m, t } = useI18n();
  const { sync } = useFinance();
  let text: string | null = null;
  let tone = "info";
  switch (sync.status) {
    case "checking": text = m.sync.checking; break;
    case "updated": {
      const r = sync.result;
      if (r.statementsAdded + r.transactionsAdded + r.transactionsUpdated + r.transactionsRemoved + r.statementsRemoved === 0) { text = m.sync.upToDate; break; }
      text = t("sync.updated", { statements: r.statementsAdded, added: r.transactionsAdded, updated: r.transactionsUpdated, removed: r.transactionsRemoved });
      tone = "ok";
      break;
    }
    case "offline": text = m.sync.offline; tone = "warn"; break;
    case "failed": text = m.sync.failed; tone = "warn"; break;
    case "currencyMismatch": text = t("sync.currencyMismatch", { web: sync.web, device: sync.device }); tone = "warn"; break;
    default: text = null;
  }
  if (!text) return null;
  return <p className={`bw-sync bw-sync-${tone}`} role="status" aria-live="polite">{text}</p>;
}
