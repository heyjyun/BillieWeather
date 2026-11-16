// Merchants (商家), projects (项目) and tags: create, rename, archive / restore, merge, delete.
import { useEffect, useState, type FormEvent } from "react";
import { PageHeading } from "../components/common";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import { LedgerError, type Dimension, type DimensionKind } from "../services/ledger";

function DimensionPanel({ kind }: { kind: DimensionKind }) {
  const { m, t } = useI18n();
  const x = m.ledger.lists;
  const { store, refresh, transactions } = useFinance();
  const [items, setItems] = useState<Dimension[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [merging, setMerging] = useState<{ id: number; into: string } | null>(null);
  const [status, setStatus] = useState("");
  const reload = async () => setItems(await store.ledger.dimensions(kind, { includeArchived: showArchived }));
  useEffect(() => { void reload(); }, [store, showArchived, transactions]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(action: () => Promise<unknown>, message = m.ledger.common.saved) {
    try {
      await action();
      await refresh();
      await reload();
      setStatus(message);
    } catch (caught) {
      setStatus(caught instanceof LedgerError ? m.ledger.errors[caught.code] ?? m.ledger.errors.unknown : m.ledger.errors.unknown);
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    await act(() => store.ledger.createDimension(kind, name));
    setName("");
  }
  const title = x[kind];
  return (
    <section className="bw-panel" aria-label={title}>
      <h2>{title}</h2>
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      {status && <p className="bw-caption">{status}</p>}
      <form className="bw-cat-form" onSubmit={add}>
        <label className="bw-field bw-grow"><span>{x.newName}</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={kind === "tag" ? 40 : 60} required /></label>
        <button type="submit" className="bw-button">{m.ledger.common.add}</button>
      </form>
      {items.length === 0 ? <p>{x.empty}</p> : (
        <ul className="bw-tx-table">
          {items.map((item) => (
            <li key={item.id} className={item.archived ? "is-excluded" : ""}>
              <div className="bw-tx-main">
                {renaming?.id === item.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); const next = renaming.name; setRenaming(null); void act(() => store.ledger.renameDimension(kind, item.id, next)); }}>
                    <input aria-label={`${m.ledger.common.rename}: ${item.name}`} value={renaming.name} onChange={(e) => setRenaming({ id: item.id, name: e.target.value })} autoFocus />
                    <button type="submit" className="bw-link-button">{m.ledger.common.save}</button>
                  </form>
                ) : <strong>{item.name}</strong>}
                <small>{t("ledger.common.entries", { count: item.entryCount })}</small>
              </div>
              {merging?.id === item.id && (
                <span>
                  <label className="bw-inline-field"><span className="bw-sr-only">{x.mergeInto}</span>
                    <select value={merging.into} onChange={(e) => setMerging({ id: item.id, into: e.target.value })}>
                      <option value="">{x.mergeInto}…</option>
                      {items.filter((other) => other.id !== item.id).map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
                    </select>
                  </label>
                  <button type="button" className="bw-link-button" disabled={!merging.into} onClick={() => { const into = Number(merging.into); setMerging(null); void act(() => store.ledger.mergeDimension(kind, item.id, into)); }}>{m.ledger.common.save}</button>
                </span>
              )}
              <div className="bw-row-actions">
                <button type="button" className="bw-link-button" onClick={() => setRenaming({ id: item.id, name: item.name })}>{m.ledger.common.rename}</button>
                <button type="button" className="bw-link-button" onClick={() => setMerging({ id: item.id, into: "" })}>{m.ledger.common.merge}</button>
                <button type="button" className="bw-link-button" onClick={() => act(() => store.ledger.setDimensionArchived(kind, item.id, !item.archived))}>{item.archived ? m.ledger.common.unarchive : m.ledger.common.archive}</button>
                <button type="button" className="bw-link-button bw-danger" title={x.deleteHelp} onClick={() => act(() => store.ledger.deleteDimension(kind, item.id))}>{m.ledger.common.delete}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <label className="bw-check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {m.ledger.common.showArchived}</label>
    </section>
  );
}

export function Lists() {
  const { m } = useI18n();
  const x = m.ledger.lists;
  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <p className="bw-caption">{x.intro}</p>
      <div className="bw-db-grid">
        <DimensionPanel kind="merchant" />
        <DimensionPanel kind="project" />
        <DimensionPanel kind="tag" />
      </div>
    </>
  );
}
