import { CURRENCIES, type Currency } from "@billie/shared-types";
import { formatMoney, ImportError } from "@billie/finance-core";
import { useState } from "react";
import { PageHeading } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import { importFile } from "../services/importFile";
import { StoreError } from "../services/store";

export function Import() {
  const { store, refresh, currency: deviceCurrency, statements } = useFinance();
  const [currency, setCurrency] = useState<Currency>(deviceCurrency ?? "USD");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const results: string[] = [];
    let failed = false;
    for (const file of Array.from(files)) {
      try {
        const result = await importFile(store, new Uint8Array(await file.arrayBuffer()), file.name, deviceCurrency ?? currency);
        results.push(`${file.name}: ${result.count} transactions imported${result.closingBalanceCents !== null ? `, closing balance ${formatMoney(result.closingBalanceCents, deviceCurrency ?? currency)}` : ""}.`);
      } catch (error) {
        failed = true;
        const text = error instanceof ImportError || error instanceof StoreError ? error.message : "The file could not be imported.";
        results.push(`${file.name}: ${text}`);
      }
    }
    await refresh();
    setBusy(false);
    setMessage({ tone: failed ? "error" : "ok", text: results.join(" ") });
  }

  return (
    <>
      <PageHeading eyebrow="ADD YOUR NUMBERS" title="Import statements" />
      <section className="bw-panel bw-import">
        <p>Choose one or more <strong>CSV</strong> statements exported from your bank. Files are read on this device and are never uploaded.</p>
        <label className="bw-field"><span>Currency</span>
          <select value={deviceCurrency ?? currency} disabled={Boolean(deviceCurrency)} onChange={(e) => setCurrency(e.target.value as Currency)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {deviceCurrency && <small>Fixed by your first import. Delete local data in Settings to switch.</small>}
        </label>
        <label className={`bw-dropzone ${busy ? "is-busy" : ""}`}>
          <input type="file" accept=".csv,text/csv" multiple disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
          <strong>{busy ? "Importing…" : "Choose CSV files"}</strong>
          <small>Needs date, description, and amount (or debit/credit) columns. Up to 2 MB and 5,000 rows each.</small>
        </label>
        {message && <p className={`bw-message bw-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
      </section>
      {statements.length > 0 && (
        <section className="bw-panel">
          <h2>Imported on this device</h2>
          <ul className="bw-simple-list">
            {[...statements].reverse().map((s) => <li key={s.id}><strong>{s.filename}</strong><small>{s.transactionCount} transactions · {s.importedAt.slice(0, 10)}</small></li>)}
          </ul>
        </section>
      )}
    </>
  );
}
