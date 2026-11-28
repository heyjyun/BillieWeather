// Accounts & Assets: one grouped, compact table shared by the Rails page and the local client.
// Platforms supply rows, per-currency summaries and the actions; this component owns the
// toolbar, the grouping, search / filter / sort, display preferences and keyboard support.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  COLUMNS, DEFAULT_PREFS, GROUPS, NO_FILTERS, REQUIRED, SORT_KEYS, buildTree, daysBetween, groupOf, matches, moveWithinType, readPrefs, shown, statusOf,
  type AccountRow, type Column, type Filters, type Group, type Node, type Prefs, type Status, type Summary, type Total,
} from "./model";
import { accountMessages, fill, type AccountMessages } from "./messages";
import "./accounts.css";

export interface TableContext {
  locale: string;
  /** The book (reporting) currency; listed first everywhere. */
  primary: string;
  today: string;
  typeNames: Record<string, string>;
  typeOrder: readonly string[];
  storageKey: string;
}
export interface TableActions {
  open(row: AccountRow): void;
  edit(row: AccountRow): void;
  transactions(row: AccountRow): void;
  addTransaction(row: AccountRow): void;
  updateBalance(row: AccountRow): void;
  importStatement?(row: AccountRow): void;
  archive(row: AccountRow): Promise<void> | void;
  unarchive(row: AccountRow): Promise<void> | void;
  remove(row: AccountRow): Promise<void> | void;
  reorder(ids: string[]): Promise<void> | void;
}

const DASH = "—";
/** Starting widths; the name column takes the rest. People can resize, and the widths are saved. */
const WIDTHS: Record<Column, number> = { institution: 132, last4: 88, type: 100, currency: 72, balance: 124, asOf: 100, status: 172 };

function loadPrefs(key: string): Prefs {
  try { return readPrefs(localStorage.getItem(key)); } catch { return structuredClone(DEFAULT_PREFS); }
}

function useFormats(locale: string, today: string) {
  return useMemo(() => {
    const money = new Map<string, Intl.NumberFormat>();
    const full = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    const short = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
    // Dates in the current year leave the year out ("Nov 26"); the tooltip text uses the same format.
    const date = { format: (ms: number) => (new Date(ms).getUTCFullYear() === Number(today.slice(0, 4)) ? short : full).format(ms) };
    return {
      money(minor: number, currency: string) {
        let format = money.get(currency);
        if (!format) {
          try { format = new Intl.NumberFormat(locale, { style: "currency", currency }); } catch { format = new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }); }
          money.set(currency, format);
        }
        return format.format(minor / 100);
      },
      date: (iso: string) => date.format(Date.parse(iso + "T00:00:00Z")),
    };
  }, [locale, today]);
}

type Formats = ReturnType<typeof useFormats>;

function Amount({ value, currency, hidden, f, c }: { value: number | null; currency: string; hidden: boolean; f: Formats; c: AccountMessages }) {
  if (hidden) return <span className="at-masked" aria-label={c.hidden}>••••••</span>;
  if (value === null) return <span className="at-dash" aria-label={c.unavailable}>{DASH}</span>;
  return <span className={value < 0 ? "at-negative" : undefined}>{f.money(value, currency)}</span>;
}

/** A button that opens a small menu; arrow keys move, Escape closes and returns focus. */
function Menu({ label, icon, children, className = "" }: { label: string; icon: ReactNode; className?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as globalThis.Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    root.current?.querySelector<HTMLElement>("[role=menuitem],[role=menuitemcheckbox],input,select,button:not(.at-menu-trigger)")?.focus();
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  function keys(event: ReactKeyboardEvent) {
    if (event.key === "Escape") { event.stopPropagation(); close(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  }
  return (
    <div className={"at-menu " + className} ref={root} onKeyDown={keys} onClick={(event) => event.stopPropagation()}>
      <button type="button" ref={button} className="at-menu-trigger" aria-haspopup="true" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)}>{icon}</button>
      {open && <div className="at-popover">{children(close)}</div>}
    </div>
  );
}

function SummaryStrip({ summaries, primary, hidden, f, c }: { summaries: Summary[]; primary: string; hidden: boolean; f: Formats; c: AccountMessages }) {
  const main = summaries.find((s) => s.currency === primary) ?? summaries[0];
  const others = summaries.filter((s) => s !== main);
  if (!main) return null;
  const metric = (label: string, value: number | null, currency: string, key: string) => (
    <div className={"at-metric at-metric-" + key}><span>{label}</span><strong><Amount value={value} currency={currency} hidden={hidden} f={f} c={c} /></strong></div>
  );
  return (
    <section className="at-summary" aria-label={c.summary}>
      <div className="at-metrics">
        {metric(c.assets, main.assets, main.currency, "assets")}
        {metric(c.liabilities, main.liabilities, main.currency, "liabilities")}
        {metric(c.netWorth, main.worth, main.currency, "worth")}
        {metric(c.liquid, main.available, main.currency, "liquid")}
      </div>
      <div className="at-summary-notes">
        {main.unknown > 0 && <span>{fill(c.unknownExcluded, { count: main.unknown })}</span>}
        {others.map((s) => (
          <span key={s.currency} className="at-other-currency">
            <b>{fill(c.otherCurrency, { currency: s.currency })}:</b> {c.assets} <Amount value={s.assets} currency={s.currency} hidden={hidden} f={f} c={c} />
            {" · "}{c.liabilities} <Amount value={s.liabilities} currency={s.currency} hidden={hidden} f={f} c={c} />
            {" · "}{c.netWorth} <Amount value={s.worth} currency={s.currency} hidden={hidden} f={f} c={c} />
            {s.unknown > 0 && <> · {fill(c.unknownExcluded, { count: s.unknown })}</>}
          </span>
        ))}
        {others.length > 0 && <span>{c.noFx}</span>}
        <span title={c.fixedAssetsNote}>{c.fixedAssets}: {c.fixedAssetsNote}</span>
      </div>
    </section>
  );
}

function Subtotals({ totals, hidden, f, c }: { totals: Total[]; hidden: boolean; f: Formats; c: AccountMessages }) {
  return (
    <>
      {totals.map((t) => (
        <span key={t.currency} className="at-subtotal" title={t.unknown ? fill(c.unknownExcluded, { count: t.unknown }) : undefined}>
          <Amount value={t.amount} currency={t.currency} hidden={hidden} f={f} c={c} />{t.unknown > 0 && !hidden && <sup aria-label={fill(c.unknownExcluded, { count: t.unknown })}>*</sup>}
        </span>
      ))}
    </>
  );
}

const icons = {
  search: <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.8 3.8" /></svg>,
  filter: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5h13M6 10h8M8.5 15h3" /></svg>,
  sort: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4v12M3 13l3 3 3-3M14 16V4M11 7l3-3 3 3" /></svg>,
  eye: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" /><circle cx="10" cy="10" r="2.4" /></svg>,
  eyeOff: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" /><path d="m3.5 3.5 13 13" /></svg>,
  more: <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.3" /><circle cx="10" cy="10" r="1.3" /><circle cx="15.5" cy="10" r="1.3" /></svg>,
  chevron: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5 5 5-5 5" /></svg>,
  grip: <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7.5" cy="5.5" r="1.1" /><circle cx="12.5" cy="5.5" r="1.1" /><circle cx="7.5" cy="10" r="1.1" /><circle cx="12.5" cy="10" r="1.1" /><circle cx="7.5" cy="14.5" r="1.1" /><circle cx="12.5" cy="14.5" r="1.1" /></svg>,
};

export interface AccountsTableProps {
  rows: AccountRow[];
  summaries: Summary[];
  context: TableContext;
  actions: TableActions;
  /** The Add Account control, rendered at the start of the toolbar. */
  add?: ReactNode;
  /** The AI / statement / manual account entry, rendered between the summary and the table. */
  children?: ReactNode;
}

export function AccountsTable({ rows, summaries, context, actions, add, children }: AccountsTableProps) {
  const c = accountMessages[context.locale] ?? accountMessages.en;
  const f = useFormats(context.locale, context.today);
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(context.storageKey));
  // The key can change after the first render (the signed-in owner becomes known): read that person's settings.
  const [loadedKey, setLoadedKey] = useState(context.storageKey);
  if (loadedKey !== context.storageKey) {
    setLoadedKey(context.storageKey);
    setPrefs(loadPrefs(context.storageKey));
  }
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [managing, setManaging] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const tableRef = useRef<HTMLTableElement>(null);
  useEffect(() => {
    if (loadedKey !== context.storageKey) return;
    try { localStorage.setItem(context.storageKey, JSON.stringify(prefs)); } catch { /* storage unavailable: keep in memory */ }
  }, [prefs, context.storageKey, loadedKey]);
  const update = (patch: Partial<Prefs>) => setPrefs((old) => ({ ...old, ...patch }));

  const groupNames = c.groups as Record<Group, string>;
  const labels = { type: context.typeNames, group: groupNames };
  const scoped = rows.filter((row) => prefs.archived === "all" || (prefs.archived === "archived") === row.archived);
  const visible = scoped.filter((row) => matches(row, filters, context.today, labels));
  const sort = managing ? { key: "custom" as const, dir: "asc" as const } : prefs.sort;
  const tree = buildTree(visible, { typeOrder: context.typeOrder, primary: context.primary, showEmpty: prefs.showEmpty && !filtered(filters), sort,
    locale: context.locale, groupNames, typeNames: context.typeNames });
  const columns = prefs.order.filter((column) => !prefs.hidden.includes(column));
  const institutions = [...new Set(rows.map((row) => row.institution).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, context.locale));
  const currencies = [...new Set(rows.map((row) => row.currency))].sort();
  // Archive and delete are confirmed in the page (browser dialogs are asynchronous in the apps).
  const [pending, setPending] = useState<{ row: AccountRow; kind: "archive" | "delete" } | null>(null);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (pending) safe.current?.focus(); }, [pending]);

  async function run(action: () => Promise<void> | void, done?: string) {
    try { await action(); if (done) setStatus(done); } catch { setStatus(c.failed); }
  }
  async function move(row: AccountRow, step: -1 | 1 | { before: string }) {
    const order = moveWithinType(rows, row.id, step);
    if (order) await run(() => actions.reorder(order), c.saved);
  }
  function toggle(key: string) {
    update({ collapsed: prefs.collapsed.includes(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key] });
  }
  function rowKeys(event: ReactKeyboardEvent<HTMLTableRowElement>, row: AccountRow) {
    if (event.target !== event.currentTarget) return;
    const all = [...(tableRef.current?.querySelectorAll<HTMLElement>("tr[data-account]") ?? [])];
    const at = all.indexOf(event.currentTarget);
    if (event.key === "Enter") { event.preventDefault(); actions.open(row); }
    else if (managing && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); void move(row, event.key === "ArrowUp" ? -1 : 1); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); all[at + (event.key === "ArrowDown" ? 1 : -1)]?.focus(); }
    else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      event.currentTarget.querySelector<HTMLButtonElement>(".at-actions .at-menu-trigger")?.click();
    }
  }

  function cell(column: Column, row: AccountRow, rowStatus: Status) {
    const value = shown(row);
    switch (column) {
      case "institution": return <td key={column} className="at-col-institution">{row.institution ?? <span className="at-dash" aria-label={c.unavailable}>{DASH}</span>}</td>;
      case "last4": return <td key={column} className="at-col-last4 at-num">{row.last4 ? `•••• ${row.last4}` : <span className="at-dash" aria-label={c.unavailable}>{DASH}</span>}</td>;
      case "type": return <td key={column} className="at-col-type">{context.typeNames[row.type] ?? row.type}</td>;
      case "currency": return <td key={column} className="at-col-currency">{row.currency}</td>;
      case "balance": {
        const title = [row.liability && value !== null && value < 0 ? c.creditBalance : row.liability ? c.owedNote : "", !row.includeInNetWorth ? c.notInNetWorth : "",
          row.creditLimit !== null && row.balance !== null ? fill(c.availableCredit, { amount: f.money(row.creditLimit + row.balance, row.currency) }) : ""].filter(Boolean).join(" · ");
        return <td key={column} className="at-col-balance at-num" title={title || undefined}>
          <Amount value={value} currency={row.currency} hidden={prefs.hideBalances} f={f} c={c} />
          {!row.includeInNetWorth && <span className="at-flag" aria-label={c.notInNetWorth}>◌</span>}
        </td>;
      }
      case "asOf": return <td key={column} className="at-col-asOf at-num">{row.confirmedOn ? f.date(row.confirmedOn) : <span className="at-dash" aria-label={c.unavailable}>{DASH}</span>}</td>;
      case "status": {
        const detail = [row.confirmedOn && row.confirmedBy ? fill(row.confirmedBy === "manual" ? c.confirmedManual : c.confirmedStatement, { date: f.date(row.confirmedOn) }) : "",
          rowStatus === "stale" && row.confirmedOn ? fill(c.staleHelp, { days: daysBetween(row.confirmedOn, context.today) }) : "",
          row.lastEntryOn ? fill(c.lastEntry, { date: f.date(row.lastEntryOn) }) : c.noEntries].filter(Boolean).join(" ");
        return <td key={column} className="at-col-status"><span className={"at-status at-status-" + rowStatus} title={detail}>{c.status[rowStatus]}</span><span className="at-sr">{detail}</span></td>;
      }
    }
  }

  function rowMenu(row: AccountRow) {
    const item = (label: string, act: () => void, danger = false) => (
      <button type="button" role="menuitem" className={danger ? "at-danger" : undefined} onClick={act}>{label}</button>
    );
    return (
      <Menu label={fill(c.actionsFor, { name: row.name })} icon={icons.more} className="at-row-menu">
        {(close) => {
          const go = (fn: () => void) => () => { close(); fn(); };
          return (
            <div role="menu" aria-label={fill(c.actionsFor, { name: row.name })}>
              {item(c.menu.open, go(() => actions.open(row)))}
              {item(c.menu.edit, go(() => actions.edit(row)))}
              {item(c.menu.transactions, go(() => actions.transactions(row)))}
              {!row.archived && item(c.menu.addTransaction, go(() => actions.addTransaction(row)))}
              {!row.archived && item(c.menu.updateBalance, go(() => actions.updateBalance(row)))}
              {row.statementDiffers && item(c.menu.reconcile, go(() => actions.updateBalance(row)))}
              {actions.importStatement && !row.archived && item(c.menu.importStatement, go(() => actions.importStatement!(row)))}
              {item(c.menu.changeType, go(() => actions.edit(row)))}
              {!row.archived && item(c.menu.move, go(() => { update({ archived: "active" }); setManaging(true); }))}
              <hr />
              {row.archived
                ? item(c.menu.unarchive, go(() => void run(() => actions.unarchive(row))))
                : item(c.menu.archive, go(() => setPending({ row, kind: "archive" })))}
              {row.canDelete && item(c.menu.delete, go(() => setPending({ row, kind: "delete" })), true)}
            </div>
          );
        }}
      </Menu>
    );
  }

  function accountRow(row: AccountRow, depth: number) {
    const rowStatus = statusOf(row, context.today);
    const draggable = managing && !row.archived;
    return (
      <tr key={row.id} data-account={row.id} tabIndex={0} aria-label={row.name} className={"at-row" + (row.archived ? " at-archived" : "") + (dragging === row.id ? " at-dragging" : "")}
        onClick={() => !managing && actions.open(row)} onKeyDown={(event) => rowKeys(event, row)}
        draggable={draggable} onDragStart={(event) => { setDragging(row.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", row.id); }}
        onDragEnd={() => setDragging(null)}
        onDragOver={(event) => { const from = rows.find((r) => r.id === dragging); if (draggable && from && from.type === row.type && from.id !== row.id) event.preventDefault(); }}
        onDrop={(event) => { event.preventDefault(); const from = rows.find((r) => r.id === dragging); setDragging(null); if (from) void move(from, { before: row.id }); }}>
        {managing && (
          <td className="at-col-manage" onClick={(event) => event.stopPropagation()}>
            {draggable && <>
              <span className="at-grip" aria-hidden="true" title={fill(c.drag, { name: row.name })}>{icons.grip}</span>
              <button type="button" className="at-step" aria-label={fill(c.moveUp, { name: row.name })} onClick={() => void move(row, -1)}>↑</button>
              <button type="button" className="at-step" aria-label={fill(c.moveDown, { name: row.name })} onClick={() => void move(row, 1)}>↓</button>
            </>}
          </td>
        )}
        <th scope="row" className="at-col-name" style={{ paddingInlineStart: 12 + depth * 16 }}>
          <span className="at-name">{row.name}</span>
          <span className="at-mobile-meta">{[row.institution ?? context.typeNames[row.type], row.last4 ? `•••• ${row.last4}` : null,
            row.confirmedOn ? f.date(row.confirmedOn) : c.status[rowStatus]].filter(Boolean).join(" · ")}</span>
        </th>
        {columns.map((column) => cell(column, row, rowStatus))}
        <td className="at-actions">{rowMenu(row)}</td>
      </tr>
    );
  }

  const span = columns.length + 2 + (managing ? 1 : 0);
  // Group subtotals sit in the balance column, so they line up with the account balances.
  const lead = (managing ? 1 : 0) + 1 + columns.indexOf("balance");
  const trail = span - lead - 1;
  function section(node: Node, depth: number): ReactNode {
    const open = !prefs.collapsed.includes(node.key);
    const countLabel = node.count === 1 ? c.countOne : fill(c.count, { count: node.count });
    return (
      <Fragment key={node.key}>
        <tr className={"at-heading at-heading-" + node.kind} data-group={node.key}>
          <th colSpan={lead} scope="rowgroup">
            <div className="at-heading-line" style={{ paddingInlineStart: depth * 16 }}>
              <button type="button" className="at-toggle" aria-expanded={open} aria-label={fill(open ? c.collapse : c.expand, { name: node.name })} onClick={() => toggle(node.key)}>
                <span className={"at-chevron" + (open ? " at-open" : "")}>{icons.chevron}</span>
                <span className="at-heading-name">{node.name}</span>
                <span className="at-heading-count">{countLabel}</span>
              </button>
            </div>
          </th>
          <td className="at-num at-heading-total"><Subtotals totals={node.totals} hidden={prefs.hideBalances} f={f} c={c} /></td>
          <td colSpan={trail} />
        </tr>
        {open && node.count === 0 && <tr className="at-empty-group"><td colSpan={span}>{c.emptyGroup}</td></tr>}
        {open && node.rows.map((row) => accountRow(row, depth + 1))}
        {open && node.children.map((child) => section(child, depth + 1))}
      </Fragment>
    );
  }

  function moveColumn(column: Column, step: -1 | 1) {
    const order = [...prefs.order];
    const at = order.indexOf(column);
    const to = at + step;
    if (to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    update({ order });
  }
  function resizer(column: Column | "name", label: string) {
    const startResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
      const th = event.currentTarget.parentElement!;
      const start = event.clientX;
      const width = th.getBoundingClientRect().width;
      const moveTo = (e: PointerEvent) => update({ widths: { ...prefs.widths, [column]: Math.max(48, Math.min(640, Math.round(width + e.clientX - start))) } });
      const stop = () => { window.removeEventListener("pointermove", moveTo); window.removeEventListener("pointerup", stop); };
      window.addEventListener("pointermove", moveTo);
      window.addEventListener("pointerup", stop);
    };
    return (
      <span role="separator" aria-orientation="vertical" tabIndex={0} aria-label={fill(c.resize, { column: label })} className="at-resize" onPointerDown={startResize}
        aria-valuenow={prefs.widths[column]} onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const th = event.currentTarget.parentElement!;
          const width = prefs.widths[column] ?? Math.round(th.getBoundingClientRect().width || 120);
          update({ widths: { ...prefs.widths, [column]: Math.max(48, Math.min(640, width + (event.key === "ArrowRight" ? 16 : -16))) } });
        }} />
    );
  }

  const filterCount = Object.entries(filters).filter(([key, value]) => key !== "query" && value).length;
  const select = <K extends keyof Filters>(key: K, label: string, options: Array<[string, string]>) => (
    <label className="at-field"><span>{label}</span>
      <select value={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })}>
        <option value="">{c.filterLabels.any}</option>
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </label>
  );

  return (
    <div className={"at-root at-density-" + prefs.density}>
      <div className="at-toolbar" role="toolbar" aria-label={c.tableSettings}>
        {add}
        <label className="at-search"><span className="at-search-icon">{icons.search}</span><span className="at-sr">{c.search}</span>
          <input type="search" value={filters.query} placeholder={c.searchPlaceholder} aria-label={c.search} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
        </label>
        <Menu label={c.filter + (filterCount ? ` (${filterCount})` : "")} icon={<>{icons.filter}<span>{c.filter}{filterCount ? ` · ${filterCount}` : ""}</span></>} className="at-tool">
          {() => (
            <div className="at-panel" role="group" aria-label={c.filter}>
              {select("group", c.filterLabels.group, GROUPS.map((g) => [g, groupNames[g]]))}
              {select("accountClass", c.filterLabels.accountClass, [["asset", c.filterLabels.asset], ["liability", c.filterLabels.liability]])}
              {select("institution", c.filterLabels.institution, institutions.map((name) => [name, name]))}
              {select("currency", c.filterLabels.currency, currencies.map((code) => [code, code]))}
              {select("origin", c.filterLabels.origin, [["manual", c.filterLabels.manual], ["imported", c.filterLabels.imported]])}
              {select("status", c.statusFilter, (Object.keys(c.status) as Status[]).filter((s) => s !== "archived").map((s) => [s, c.status[s]]))}
              <label className="at-field"><span>{c.view}</span>
                <select value={prefs.archived} onChange={(event) => update({ archived: event.target.value as Prefs["archived"] })}>
                  {(["active", "archived", "all"] as const).map((v) => <option key={v} value={v}>{c.views[v]}</option>)}
                </select>
              </label>
              <button type="button" className="at-link" onClick={() => setFilters({ ...NO_FILTERS, query: filters.query })}>{c.clearFilters}</button>
            </div>
          )}
        </Menu>
        <Menu label={c.sort} icon={<>{icons.sort}<span>{c.sortKeys[prefs.sort.key]}</span></>} className="at-tool">
          {() => (
            <div className="at-panel" role="group" aria-label={c.sort}>
              <label className="at-field"><span>{c.sort}</span>
                <select value={prefs.sort.key} onChange={(event) => update({ sort: { ...prefs.sort, key: event.target.value as Prefs["sort"]["key"] } })}>
                  {SORT_KEYS.map((key) => <option key={key} value={key}>{c.sortKeys[key]}</option>)}
                </select>
              </label>
              <label className="at-field"><span>{c.sortKeys[prefs.sort.key]}</span>
                <select value={prefs.sort.dir} onChange={(event) => update({ sort: { ...prefs.sort, dir: event.target.value as "asc" | "desc" } })}>
                  <option value="asc">{c.ascending}</option><option value="desc">{c.descending}</option>
                </select>
              </label>
            </div>
          )}
        </Menu>
        <button type="button" className="at-tool-button" aria-pressed={prefs.hideBalances} title={prefs.hideBalances ? c.showBalances : c.hideBalances}
          aria-label={c.hideBalances} onClick={() => update({ hideBalances: !prefs.hideBalances })}>{prefs.hideBalances ? icons.eyeOff : icons.eye}</button>
        <Menu label={c.more} icon={icons.more} className="at-tool at-more">
          {(close) => (
            <div className="at-panel at-settings">
              <button type="button" role="menuitem" onClick={() => { close(); update({ archived: "active" }); setManaging(true); }}>{c.reorder}</button>
              <fieldset><legend>{c.columnsTitle}</legend>
                {prefs.order.map((column, index) => (
                  <div key={column} className="at-column-row">
                    <label><input type="checkbox" checked={!prefs.hidden.includes(column)} disabled={REQUIRED.includes(column)}
                      onChange={(event) => update({ hidden: event.target.checked ? prefs.hidden.filter((h) => h !== column) : [...prefs.hidden, column] })} /> {c.columns[column]}</label>
                    <button type="button" className="at-step" disabled={index === 0} aria-label={fill(c.moveColumnUp, { column: c.columns[column] })} onClick={() => moveColumn(column, -1)}>↑</button>
                    <button type="button" className="at-step" disabled={index === COLUMNS.length - 1} aria-label={fill(c.moveColumnDown, { column: c.columns[column] })} onClick={() => moveColumn(column, 1)}>↓</button>
                  </div>
                ))}
              </fieldset>
              <fieldset><legend>{c.density}</legend>
                {(["compact", "comfortable"] as const).map((d) => (
                  <label key={d}><input type="radio" name="at-density" checked={prefs.density === d} onChange={() => update({ density: d })} /> {c[d]}</label>
                ))}
              </fieldset>
              <label><input type="checkbox" checked={prefs.showEmpty} onChange={(event) => update({ showEmpty: event.target.checked })} /> {c.showEmpty}</label>
              <button type="button" className="at-link" onClick={() => { setPrefs(structuredClone(DEFAULT_PREFS)); close(); }}>{c.resetLayout}</button>
            </div>
          )}
        </Menu>
      </div>

      <SummaryStrip summaries={summaries} primary={context.primary} hidden={prefs.hideBalances} f={f} c={c} />
      {children}

      <p className="at-sr" role="status" aria-live="polite">{status}</p>
      {pending && (
        <div className="at-confirm" role="alertdialog" aria-labelledby="at-confirm-question" tabIndex={-1}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setPending(null); } }}>
          <p id="at-confirm-question">{fill(pending.kind === "archive" ? c.confirmArchive : c.confirmDelete, { name: pending.row.name })}</p>
          <button type="button" className={pending.kind === "delete" ? "at-confirm-danger" : "at-confirm-go"}
            onClick={() => { const { row, kind } = pending; setPending(null); void run(() => (kind === "archive" ? actions.archive(row) : actions.remove(row))); }}>
            {pending.kind === "archive" ? c.menu.archive : c.menu.delete}
          </button>
          <button type="button" ref={safe} className="at-link" onClick={() => setPending(null)}>{c.cancel}</button>
        </div>
      )}
      {managing && (
        <div className="at-managing" role="note">
          <span>{c.managing}</span>
          <button type="button" className="at-done" onClick={() => setManaging(false)}>{c.done}</button>
        </div>
      )}
      {(filtered(filters) || prefs.archived !== "active") && rows.length > 0 && (
        <p className="at-results">{fill(c.results, { shown: visible.length, total: scoped.length })}</p>
      )}
      {rows.length === 0 ? (
        <p className="at-empty">{c.empty}</p>
      ) : tree.length === 0 ? (
        <p className="at-empty">{c.noResults}</p>
      ) : (
        <div className="at-scroll">
          <table className="at-table" ref={tableRef}>
            <colgroup>
              {managing && <col style={{ width: 92 }} />}
              <col style={{ width: prefs.widths.name }} />
              {columns.map((column) => <col key={column} style={{ width: prefs.widths[column] ?? WIDTHS[column] }} />)}
              <col style={{ width: 44 }} />
            </colgroup>
            <thead>
              <tr>
                {managing && <th scope="col"><span className="at-sr">{c.reorder}</span></th>}
                <th scope="col" className="at-col-name">{c.columns.name}{resizer("name", c.columns.name)}</th>
                {columns.map((column) => (
                  <th key={column} scope="col" className={"at-col-" + column + (["balance", "last4", "asOf"].includes(column) ? " at-num" : "")}>
                    {c.columns[column]}{resizer(column, c.columns[column])}
                  </th>
                ))}
                <th scope="col" className="at-actions"><span className="at-sr">{c.columns.actions}</span></th>
              </tr>
            </thead>
            <tbody>{tree.map((node) => section(node, 0))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Opens the existing AI / statement / manual account entry panel and puts the cursor in it. */
export function openCapture(scope: ParentNode = document) {
  const panel = scope.querySelector<HTMLElement>(".bw-account-capture");
  if (!panel) return false;
  if (panel instanceof HTMLDetailsElement) panel.open = true;
  panel.scrollIntoView?.({ block: "nearest" });
  panel.querySelector<HTMLElement>("textarea")?.focus();
  return true;
}

function filtered(filters: Filters) {
  return Object.values(filters).some(Boolean);
}

export { groupOf };
