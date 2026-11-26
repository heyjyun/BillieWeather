// The category tree (docs/architecture/category-hierarchy.md): categories nest at any depth, top-level
// categories are shown with their subcategories collapsed, and each expand/collapse is saved with the
// category (categories.expanded). Every category can be renamed, given subcategories, moved, reordered
// among its siblings, hidden, merged or deleted with a destination for its entries; Transfers can't be
// deleted, merged away or moved under another category. Uncategorized is not a category and is not listed.
import { useState, type FormEvent, type ReactNode } from "react";
import { CATEGORY_NAME_MAX, SYSTEM_KEYS, UNCATEGORIZED, type CategoryNode } from "@billie/finance-core";
import { InlineDialog, indented } from "./common";
import { useFinance } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";
import { LedgerError } from "../services/ledger";
import { StoreError } from "../services/store";

type Dialog =
  | { type: "rename"; name: string; value: string }
  | { type: "add"; name: string; value: string }
  | { type: "move"; name: string; parent: string }
  | { type: "merge"; name: string; into: string }
  | { type: "delete"; name: string; moveTo: string };

export function CategoryTree() {
  const { m, t } = useI18n();
  const x = m.ledger.categoriesTree;
  const { store, categoryTree: tree, refresh } = useFinance();
  const [status, setStatus] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Expansion as saved, overridden at once by the person's clicks (saved in the background).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const all = tree.flatten({ includeHidden: true });
  const label = (name: string) => categoryLabel(m, name);

  async function act<T>(action: () => Promise<T>, message: string | ((result: T) => string) = m.ledger.common.saved) {
    setDialog(null);
    try {
      const result = await action();
      await refresh();
      setStatus(typeof message === "function" ? message(result) : message);
    } catch (caught) {
      const code = caught instanceof LedgerError || caught instanceof StoreError ? caught.code : "unknown";
      const problem = caught instanceof StoreError && caught.code === "invalid_category" ? String(caught.vars.problem) : null;
      const page = m.categoryPage;
      setStatus(problem === "taken" ? page.errorTaken : problem === "reserved" ? page.errorReserved : problem === "too_long" ? t("categoryPage.errorTooLong", { max: CATEGORY_NAME_MAX })
        : problem ? page.errorBlank : (m.ledger.errors as Record<string, string>)[code] ?? m.ledger.errors.unknown);
    }
  }

  const isOpen = (node: CategoryNode) => expanded[node.name.toLowerCase()] ?? node.expanded;
  function toggle(node: CategoryNode) {
    const next = !isOpen(node);
    setExpanded((current) => ({ ...current, [node.name.toLowerCase()]: next }));
    void store.ledger.setCategoryExpanded(node.name, next).catch(() => undefined);
  }

  async function addSuggested() {
    await act(() => store.addSuggestedCategories(), (added) => (added.length ? t("ledger.categoriesTree.suggestedAdded", { count: added.length }) : x.suggestedNone));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dialog) return;
    if (dialog.type === "rename") void act(() => store.renameCategory(dialog.name, dialog.value));
    if (dialog.type === "add") void act(() => store.addCategory(dialog.value, dialog.name), t("categoryPage.added", { name: dialog.value.trim() }));
    if (dialog.type === "move") void act(() => store.moveCategory(dialog.name, dialog.parent || null));
    if (dialog.type === "merge" && dialog.into) void act(() => store.mergeCategory(dialog.name, dialog.into), t("ledger.categoriesTree.merged", { from: dialog.name, into: label(dialog.into) }));
    if (dialog.type === "delete") void act(() => store.deleteCategory(dialog.name, dialog.moveTo));
  }

  const kindLabel = (node: CategoryNode) => (node.kind === "income" ? x.income : node.kind === "expense" ? x.expense : m.ledger.kinds.transfer);

  function row(node: CategoryNode): ReactNode {
    const transfers = node.key === SYSTEM_KEYS.transfers;
    const open = isOpen(node);
    const listId = `category-children-${encodeURIComponent(node.name)}`;
    return (
      <li key={node.name} className={node.hidden ? "is-excluded" : ""} style={{ paddingInlineStart: node.depth ? `${node.depth * 1.5}rem` : undefined }}>
        <div className="bw-tx-main">
          <strong>
            {node.children.length > 0 ? (
              <button type="button" className="bw-link-button" aria-expanded={open} aria-controls={listId}
                aria-label={t(open ? "ledger.categoriesTree.collapse" : "ledger.categoriesTree.expand", { name: label(node.name) })} onClick={() => toggle(node)}>{open ? "▾" : "▸"}</button>
            ) : <span aria-hidden="true">{node.depth ? "› " : ""}</span>}
            {" "}{label(node.name)}
          </strong>
          <small>{kindLabel(node)}{node.hidden ? ` · ${x.hidden}` : ""}{node.children.length ? ` · ${node.children.length}` : ""}</small>
        </div>
        <div className="bw-row-actions" role="group" aria-label={t("ledger.categoriesTree.actionsFor", { name: label(node.name) })}>
          {node.depth === 0 && !transfers && (
            <label className="bw-inline-field">
              <span className="bw-sr-only">{x.tree}: {node.name}</span>
              <select value={node.kind} onChange={(e) => act(() => store.ledger.setCategoryMeta(node.name, { kind: e.target.value as "income" | "expense" }))}>
                <option value="expense">{x.expense}</option>
                <option value="income">{x.income}</option>
              </select>
            </label>
          )}
          <button type="button" className="bw-link-button" aria-label={`${m.ledger.common.moveUp}: ${node.name}`} onClick={() => act(() => store.ledger.moveCategoryStep(node.name, -1))}>↑</button>
          <button type="button" className="bw-link-button" aria-label={`${m.ledger.common.moveDown}: ${node.name}`} onClick={() => act(() => store.ledger.moveCategoryStep(node.name, 1))}>↓</button>
          <button type="button" className="bw-link-button" onClick={() => setDialog({ type: "rename", name: node.name, value: node.name })}>{m.ledger.common.rename}</button>
          <button type="button" className="bw-link-button" onClick={() => setDialog({ type: "add", name: node.name, value: "" })}>{x.addSub}</button>
          {!transfers && <button type="button" className="bw-link-button" onClick={() => setDialog({ type: "move", name: node.name, parent: node.parent ?? "" })}>{x.move}</button>}
          {!transfers && <button type="button" className="bw-link-button" onClick={() => act(() => store.ledger.setCategoryMeta(node.name, { hidden: !node.hidden }))}>{node.hidden ? x.show : x.hide}</button>}
          {!transfers && <button type="button" className="bw-link-button" onClick={() => setDialog({ type: "merge", name: node.name, into: "" })}>{m.ledger.common.merge}</button>}
          {!transfers && <button type="button" className="bw-link-button bw-danger" onClick={() => setDialog({ type: "delete", name: node.name, moveTo: node.parent ?? UNCATEGORIZED })}>{m.ledger.common.delete}</button>}
        </div>
        {dialog && dialog.name === node.name && dialogFor(node)}
        {node.children.length > 0 && open && <ul id={listId} className="bw-category-children">{node.children.map(row)}</ul>}
      </li>
    );
  }

  function dialogFor(node: CategoryNode) {
    if (!dialog) return null;
    const inside = new Set(tree.subtree(node.name).map((name) => name.toLowerCase()));
    const outside = all.filter((item) => !inside.has(item.name.toLowerCase()));
    const option = (item: CategoryNode) => <option key={item.name} value={item.name}>{indented(label(item.name), item.depth)}</option>;
    return (
      <InlineDialog className="bw-confirm" role={dialog.type === "delete" ? "alertdialog" : undefined} label={dialog.type === "delete" ? m.ledger.common.delete : dialog.type === "merge" ? m.ledger.common.merge : dialog.type === "move" ? x.move : dialog.type === "add" ? x.addSub : m.ledger.common.rename} onCancel={() => setDialog(null)}>
        <form className="bw-cat-form" onSubmit={submit}>
          {dialog.type === "rename" && (
            <label className="bw-field bw-grow"><span>{t("ledger.categoriesTree.renameTo", { name: label(node.name) })}</span>
              <input value={dialog.value} maxLength={CATEGORY_NAME_MAX} required onChange={(e) => setDialog({ ...dialog, value: e.target.value })} /></label>
          )}
          {dialog.type === "add" && (
            <label className="bw-field bw-grow"><span>{t("ledger.categoriesTree.subName", { name: label(node.name) })}</span>
              <input value={dialog.value} maxLength={CATEGORY_NAME_MAX} required onChange={(e) => setDialog({ ...dialog, value: e.target.value })} /></label>
          )}
          {dialog.type === "move" && (
            <label className="bw-field"><span>{t("ledger.categoriesTree.moveUnder", { name: label(node.name) })}</span>
              <select value={dialog.parent} onChange={(e) => setDialog({ ...dialog, parent: e.target.value })}>
                <option value="">{x.topLevel}</option>
                {outside.map(option)}
              </select></label>
          )}
          {dialog.type === "merge" && (
            <label className="bw-field"><span>{node.name} → </span>
              <select value={dialog.into} onChange={(e) => setDialog({ ...dialog, into: e.target.value })}>
                <option value="">—</option>
                {outside.map(option)}
              </select></label>
          )}
          {dialog.type === "delete" && (
            <label className="bw-field"><span>{x.deleteMoveTo}</span>
              <select value={dialog.moveTo} onChange={(e) => setDialog({ ...dialog, moveTo: e.target.value })}>
                {all.filter((item) => item.name !== node.name).map(option)}
                <option value={UNCATEGORIZED}>{label(UNCATEGORIZED)}</option>
              </select></label>
          )}
          <button type="submit" className={dialog.type === "delete" ? "bw-button bw-button-danger" : "bw-button"} disabled={dialog.type === "merge" && !dialog.into}>
            {dialog.type === "delete" ? m.ledger.common.delete : m.ledger.common.save}
          </button>
          <button type="button" className="bw-link-button" onClick={() => setDialog(null)}>{m.ledger.common.cancel}</button>
        </form>
      </InlineDialog>
    );
  }

  return (
    <section className="bw-panel bw-section-gap" aria-labelledby="tree-heading">
      <h2 id="tree-heading">{x.title}</h2>
      <p className="bw-caption">{x.intro}</p>
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      <div className="bw-db-actions">
        <button type="button" className="bw-button bw-button-outline" onClick={addSuggested}>{x.addSuggested}</button>
        <small className="bw-caption">{x.suggestedHelp}</small>
      </div>
      <ul className="bw-tx-table bw-category-tree">
        {tree.roots.map(row)}
      </ul>
    </section>
  );
}
