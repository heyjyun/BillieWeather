import { useState } from "react";
import { PageHeading } from "../components/common";
import { useFinance } from "../hooks/useFinance";

export function Settings() {
  const { store, refresh, rules, statements, transactions, persistent } = useFinance();
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState("");

  async function deleteAll() {
    await store.deleteAllData();
    await refresh();
    setConfirm("");
    setStatus("All local financial data was deleted from this device.");
  }

  return (
    <>
      <PageHeading eyebrow="YOUR DATA, YOUR RULES" title="Settings & privacy" />
      <section className="bw-panel">
        <h2>Where your data lives</h2>
        <p>{persistent
          ? "Statements, transactions, and remembered rules are stored in a SQLite database in this app's private storage on this device. BillieWeather does not upload, sync, or back them up anywhere."
          : "Preview mode: running in a browser, so data is kept in memory only and disappears when you close the tab."}</p>
        <ul className="bw-privacy-list">
          <li>No account needed. Works fully offline.</li>
          <li>No analytics, tracking, or crash reporting.</li>
          <li>Network access is blocked by the app's security policy.</li>
          <li>Exports are written only to files you choose.</li>
        </ul>
        <p className="bw-caption">Encryption at rest: not yet enabled. The database relies on your device's own protection (FileVault, BitLocker, iOS/Android storage encryption) for now.</p>
        <p className="bw-caption">{statements.length} statements · {transactions.length} transactions · {rules.length} remembered rules on this device.</p>
      </section>

      <section className="bw-panel">
        <h2>Remembered category rules</h2>
        {rules.length === 0 ? <p className="bw-muted">When you change a category with "remember" on, the rule appears here.</p> : (
          <ul className="bw-simple-list">
            {rules.map((rule) => (
              <li key={`${rule.merchantKey}-${rule.income}`}>
                <strong>{rule.merchantKey}</strong>
                <small>{rule.income ? "Money in" : "Money out"} → {rule.category}</small>
                <button className="bw-link-button" onClick={async () => { await store.deleteRule(rule); await refresh(); }}>Forget</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bw-panel bw-danger">
        <h2>Delete local data</h2>
        <p>Permanently deletes every statement, transaction, and remembered rule from this device. This cannot be undone. Exported files you saved elsewhere are not affected.</p>
        <label className="bw-field"><span>Type DELETE to confirm</span><input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></label>
        <button className="bw-button bw-button-danger" disabled={confirm !== "DELETE"} onClick={deleteAll}>Delete all local data</button>
        <p role="status" aria-live="polite" className="bw-sr-status">{status}</p>
      </section>
    </>
  );
}
