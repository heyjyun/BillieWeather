// Transactions › Add & Sync: every way to bring transactions in. It opens the existing tools (Import,
// Receipt, manual entry); it adds no new ingestion path. Connect Financial Accounts is Coming soon:
// BillieWeather has no bank connection, and nothing here pretends otherwise.
import { PageHeading } from "../components/common";
import { ModuleIcon } from "../components/ModuleIcon";
import { useState, type FormEvent } from "react";
import { useI18n } from "../i18n";
import { quickEntryCopy } from "../i18n/quickEntry";
import { parseQuickEntry, type QuickEntry } from "../services/quickEntry";

export function AddSync({ openImport, openReceipt, openEntry, openManual }: { openImport: () => void; openReceipt: () => void; openEntry: (draft?: QuickEntry) => void; openManual: () => void }) {
  const { m, locale } = useI18n();
  const [description, setDescription] = useState("");
  const [invalid, setInvalid] = useState(false);
  const copy = quickEntryCopy[locale];
  const supportsTypedEntry = locale === "en" || locale === "zh-CN" || locale === "zh-TW";
  function review(event: FormEvent) {
    event.preventDefault();
    const draft = parseQuickEntry(description);
    if (draft) openEntry(draft);
    else setInvalid(true);
  }

  const x = m.modules.addSync;
  const badge = (available: boolean) => <span className={`bw-badge ${available ? "bw-badge-available" : "bw-badge-soon"}`}>{available ? x.available : x.comingSoon}</span>;
  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <p className="bw-muted">{x.intro}</p>
      <ul className="bw-capability-grid" role="list" id="add-sync">
        <li className="bw-capability is-coming-soon" id="capability-connect">
          <div className="bw-capability-head"><span className="bw-library-icon"><ModuleIcon name="link" size={22} /></span><h2>{x.connect.title}</h2>{badge(false)}</div>
          <p>{x.connect.body}</p>
          <p className="bw-caption">{x.connect.note}</p>
        </li>
        <li className="bw-capability" id="capability-import">
          <div className="bw-capability-head"><span className="bw-library-icon"><ModuleIcon name="upload" size={22} /></span><h2>{x.import.title}</h2>{badge(true)}</div>
          <p>{x.import.body}</p>
          <div className="bw-capability-actions"><button type="button" className="bw-button bw-button-dark" onClick={openImport}>{x.import.open}</button></div>
        </li>
        <li className="bw-capability" id="capability-scan">
          <div className="bw-capability-head"><span className="bw-library-icon"><ModuleIcon name="camera" size={22} /></span><h2>{x.scan.title}</h2>{badge(true)}</div>
          <p>{x.scan.body}</p>
          <p className="bw-caption">{x.scan.rules}</p>
          <div className="bw-capability-actions"><button type="button" className="bw-button bw-button-dark" onClick={openReceipt}>{x.scan.open}</button></div>
        </li>
        <li className="bw-capability" id="capability-quick-add">
          <div className="bw-capability-head"><span className="bw-library-icon"><ModuleIcon name="plus" size={22} /></span><h2>{x.quickAdd.title}</h2>{badge(true)}</div>
          <p>{x.quickAdd.body}</p>
          {supportsTypedEntry && <form className="bw-quick-entry" onSubmit={review}>
            <div className="bw-field">
              <label htmlFor="quick-entry-text">{copy.label}</label>
              <input id="quick-entry-text" type="text" value={description} maxLength={195} placeholder={copy.example} autoComplete="off"
                aria-describedby="quick-entry-help" aria-invalid={invalid || undefined}
                onChange={(event) => { setDescription(event.target.value); setInvalid(false); }} />
              <small id="quick-entry-help">{copy.help}</small>
            </div>
            {invalid && <p className="bw-field-error" role="alert">{copy.invalid}</p>}
            <button type="submit" className="bw-button bw-button-outline">{copy.review}</button>
          </form>}
          <div className="bw-capability-actions">
            <button type="button" className="bw-button bw-button-dark" onClick={() => openEntry()} aria-keyshortcuts="Control+Shift+E Meta+Shift+E">{x.quickAdd.open}</button>
            <button type="button" className="bw-link-button" onClick={openManual}>{x.quickAdd.manual}</button>
          </div>
        </li>
      </ul>
    </>
  );
}
