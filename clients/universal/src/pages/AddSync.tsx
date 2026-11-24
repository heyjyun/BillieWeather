// Transactions › Add & Sync: every way to bring transactions in. It opens the existing tools (Import,
// Receipt, manual entry); it adds no new ingestion path. Connect Financial Accounts is Coming soon:
// BillieWeather has no bank connection, and nothing here pretends otherwise.
import { PageHeading } from "../components/common";
import { ModuleIcon } from "../components/ModuleIcon";
import { useI18n } from "../i18n";

export function AddSync({ openImport, openReceipt, openEntry, openManual }: { openImport: () => void; openReceipt: () => void; openEntry: () => void; openManual: () => void }) {
  const { m } = useI18n();
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
          <p className="bw-caption">{x.quickAdd.later}</p>
          <div className="bw-capability-actions">
            <button type="button" className="bw-button bw-button-dark" onClick={openEntry}>{x.quickAdd.open}</button>
            <button type="button" className="bw-link-button" onClick={openManual}>{x.quickAdd.manual}</button>
          </div>
        </li>
      </ul>
    </>
  );
}
