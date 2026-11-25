// The two-level category tree (一级/二级分类): parent, income or expense tree, hide/show, reorder,
// merge one category into another, and delete with a chosen destination for its entries.
import { useEffect, useState } from "react";
import { InlineDialog } from "./common";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { LedgerError, type CategoryNode } from "../services/ledger";
import { StoreError } from "../services/store";

export function CategoryTree() {
  const { m, t } = useI18n();
  const x = m.ledger.categoriesTree;
  const { store, customCategories, refresh } = useFinance();
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [status, setStatus] = useState("");
  const [deleting, setDeleting] = useState<{ name: string; moveTo: string } | null>(null);
  const [merging, setMerging] = useState<{ name: string; into: string } | null>(null);

  const reload = async () => setTree(await store.ledger.categoryTree(customCategories));
  useEffect(() => { void reload(); }, [store, customCategories]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = tree.flatMap((node) => [node, ...node.children]);
  const parents = tree.filter((node) => node.kind === "expense" || node.kind === "income");
  async function act(action: () => Promise<unknown>, message = m.ledger.common.saved) {
    try {
      await action();
      await refresh();
      await reload();
      setStatus(message);
    } catch (caught) {
      const code = caught instanceof LedgerError || caught instanceof StoreError ? caught.code : "unknown";
      setStatus((m.ledger.errors as Record<string, string>)[code] ?? m.ledger.errors.unknown);
    }
  }
  async function move(node: CategoryNode, step: -1 | 1) {
    const siblings = node.parent ? tree.find((parent) => parent.name === node.parent)!.children : tree;
    const names = siblings.map((item) => item.name);
    const index = names.indexOf(node.name);
    const swap = index + step;
    if (swap < 0 || swap >= names.length) return;
    [names[index], names[swap]] = [names[swap], names[index]];
    await act(() => store.ledger.reorderCategories(names));
  }

  const row = (node: CategoryNode, depth: number) => (
    <li key={node.name} className={node.hidden ? "is-excluded" : ""} style={{ paddingInlineStart: depth ? "1.5rem" : undefined }}>
      <div className="bw-tx-main">
        <strong>{depth ? "› " : ""}{categoryLabel(m, node.name)}</strong>
        <small>{node.kind === "income" ? x.income : node.kind === "expense" ? x.expense : node.kind === "transfer" ? m.ledger.kinds.transfer : "—"}{node.hidden ? ` · ${x.hidden}` : ""}</small>
      </div>
      <div className="bw-row-actions">
        {!node.builtIn && node.children.length === 0 && (
          <label className="bw-inline-field">
            <span className="bw-sr-only">{x.parent}: {node.name}</span>
            <select value={node.parent ?? ""} onChange={(e) => act(() => store.ledger.setCategoryMeta(node.name, { parent: e.target.value || null }, customCategories))}>
              <option value="">{x.topLevel}</option>
              {parents.filter((parent) => parent.name !== node.name && parent.name !== "Uncategorized").map((parent) => <option key={parent.name} value={parent.name}>{categoryLabel(m, parent.name)}</option>)}
            </select>
          </label>
        )}
        {!node.builtIn && !node.parent && (
          <label className="bw-inline-field">
            <span className="bw-sr-only">{x.tree}: {node.name}</span>
            <select value={node.kind === "income" ? "income" : "expense"} onChange={(e) => act(() => store.ledger.setCategoryMeta(node.name, { kind: e.target.value as "income" | "expense" }, customCategories))}>
              <option value="expense">{x.expense}</option>
              <option value="income">{x.income}</option>
            </select>
          </label>
        )}
        <button type="button" className="bw-link-button" aria-label={`${m.ledger.common.moveUp}: ${node.name}`} onClick={() => move(node, -1)}>↑</button>
        <button type="button" className="bw-link-button" aria-label={`${m.ledger.common.moveDown}: ${node.name}`} onClick={() => move(node, 1)}>↓</button>
        {node.name !== "Uncategorized" && node.name !== "Transfers" && (
          <button type="button" className="bw-link-button" onClick={() => act(() => store.ledger.setCategoryMeta(node.name, { hidden: !node.hidden }, customCategories))}>{node.hidden ? x.show : x.hide}</button>
        )}
        {!node.builtIn && <button type="button" className="bw-link-button" onClick={() => setMerging({ name: node.name, into: "" })}>{m.ledger.common.merge}</button>}
        {!node.builtIn && <button type="button" className="bw-link-button bw-danger" onClick={() => setDeleting({ name: node.name, moveTo: node.parent ?? "Uncategorized" })}>{m.ledger.common.delete}</button>}
      </div>
    </li>
  );

  return (
    <section className="bw-panel bw-section-gap" aria-labelledby="tree-heading">
      <h2 id="tree-heading">{x.title}</h2>
      <p className="bw-caption">{x.intro}</p>
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      {merging && (
        <InlineDialog className="bw-confirm" label={m.ledger.common.merge} onCancel={() => setMerging(null)}>
          <label className="bw-field"><span>{merging.name} → </span>
            <select value={merging.into} onChange={(e) => setMerging({ ...merging, into: e.target.value })}>
              <option value="">—</option>
              {flat.filter((node) => node.name !== merging.name && node.kind !== "transfer").map((node) => <option key={node.name} value={node.name}>{categoryLabel(m, node.name)}</option>)}
            </select>
          </label>
          <button type="button" className="bw-button" disabled={!merging.into} onClick={() => { const { name, into } = merging; setMerging(null); void act(() => store.mergeCategory(name, into), t("ledger.categoriesTree.merged", { from: name, into: categoryLabel(m, into) })); }}>{m.ledger.common.save}</button>
          <button type="button" className="bw-link-button" onClick={() => setMerging(null)}>{m.ledger.common.cancel}</button>
        </InlineDialog>
      )}
      {deleting && (
        <InlineDialog className="bw-confirm" role="alertdialog" label={m.ledger.common.delete} onCancel={() => setDeleting(null)}>
          <label className="bw-field"><span>{x.deleteMoveTo}</span>
            <select value={deleting.moveTo} onChange={(e) => setDeleting({ ...deleting, moveTo: e.target.value })}>
              {flat.filter((node) => node.name !== deleting.name && node.kind !== "transfer").map((node) => <option key={node.name} value={node.name}>{categoryLabel(m, node.name)}</option>)}
            </select>
          </label>
          <button type="button" className="bw-button bw-button-danger" onClick={() => { const { name, moveTo } = deleting; setDeleting(null); void act(() => store.deleteCategory(name, moveTo)); }}>{m.ledger.common.delete}</button>
          <button type="button" className="bw-link-button" onClick={() => setDeleting(null)}>{m.ledger.common.cancel}</button>
        </InlineDialog>
      )}
      <ul className="bw-tx-table bw-category-tree">
        {tree.map((node) => [row(node, 0), ...node.children.map((child) => row(child, 1))])}
      </ul>
    </section>
  );
}
