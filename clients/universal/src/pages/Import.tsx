import { CURRENCIES, type Currency } from "@billie/shared-types";
import { formatMoney, ImportError } from "@billie/finance-core";
import { useState } from "react";
import { PageHeading } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import { interpolate, useI18n } from "../i18n";
import importErrors from "../i18n/importErrors.json";
import { importFile } from "../services/importFile";
import { StoreError } from "../services/store";

export function Import() {
  const { m, t, locale } = useI18n();
  const { store, refresh, currency: deviceCurrency, statements } = useFinance();
  const [currency, setCurrency] = useState<Currency>(deviceCurrency ?? "USD");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const x = m.import;

  function errorText(error: unknown): string {
    if (error instanceof ImportError || error instanceof StoreError) {
      const translated = (importErrors as Record<string, Record<string, string>>)[locale]?.[error.code];
      if (translated) return interpolate(translated, error.vars);
    }
    return x.genericError;
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    const lines: string[] = [];
    let failed = false;
    const cur = deviceCurrency ?? currency;
    for (const file of Array.from(files)) {
      try {
        const result = await importFile(store, new Uint8Array(await file.arrayBuffer()), file.name, cur);
        lines.push(result.closingBalanceCents === null
          ? t("import.success", { file: file.name, count: result.count })
          : t("import.successBalance", { file: file.name, count: result.count, balance: formatMoney(result.closingBalanceCents, cur) }));
      } catch (error) {
        failed = true;
        lines.push(t("import.failed", { file: file.name, message: errorText(error) }));
      }
    }
    await refresh();
    setBusy(false);
    setMessage({ tone: failed ? "error" : "ok", text: lines.join(" ") });
  }

  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <section className="bw-panel bw-import">
        <p>{x.intro}</p>
        <label className="bw-field"><span>{x.currency}</span>
          <select value={deviceCurrency ?? currency} disabled={Boolean(deviceCurrency)} onChange={(e) => setCurrency(e.target.value as Currency)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {deviceCurrency && <small>{x.currencyLocked}</small>}
        </label>
        <label className={`bw-dropzone ${busy ? "is-busy" : ""}`}>
          <input type="file" accept=".csv,text/csv" multiple disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
          <strong>{busy ? x.importing : x.choose}</strong>
          <small>{x.requirements}</small>
        </label>
        {message && <p className={`bw-message bw-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
      </section>
      {statements.length > 0 && (
        <section className="bw-panel">
          <h2>{x.history}</h2>
          <ul className="bw-simple-list">
            {[...statements].reverse().map((statement) => (
              <li key={statement.id}><strong>{statement.filename}</strong><small>{t("import.historyItem", { count: statement.transactionCount, date: statement.importedAt.slice(0, 10) })}</small></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
