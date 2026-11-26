import type { BuiltInCategory, Category, PeriodPreset } from "@billie/shared-types";
import { formatMoney, type CategoryTree } from "@billie/finance-core";
import { useId, useMemo, useState, type ReactNode } from "react";
import { useFocusWhenLost, useOpenedPanel } from "../hooks/useFocus";
import { useOptionalCategoryTree } from "../hooks/useFinance";
import { categoryLabel, useI18n } from "../i18n";

export function Money({ cents, currency, signed = false }: { cents: number; currency: string; signed?: boolean }) {
  const tone = signed ? (cents > 0 ? "bw-positive" : cents < 0 ? "bw-negative" : "") : "";
  return <span className={`bw-money ${tone}`}>{signed && cents > 0 ? "+" : ""}{formatMoney(cents, currency)}</span>;
}

const CATEGORY_TONES: Record<BuiltInCategory, string> = {
  Income: "green", Housing: "blue", "Food & dining": "orange", Transport: "purple", Utilities: "teal",
  Shopping: "pink", Health: "red", Business: "gold", Transfers: "gray", Uncategorized: "gray",
};
/** The same colors by default key: a category takes its top-level category's color, renamed or not. */
const KEY_TONES: Record<string, string> = { income: "green", housing: "blue", food: "orange", transport: "purple", utilities: "teal", shopping: "pink", health: "red", business: "gold", transfers: "gray" };

export function CategoryBadge({ category }: { category: Category }) {
  const { m } = useI18n();
  const tree = useOptionalCategoryTree();
  const root = tree?.rootOf(category);
  const tone = root ? (root.key ? KEY_TONES[root.key] : undefined) ?? "slate"
    : Object.prototype.hasOwnProperty.call(CATEGORY_TONES, category) ? CATEGORY_TONES[category as BuiltInCategory] : "slate";
  return <span className={`bw-category bw-tone-${tone}`}>{categoryLabel(m, category)}</span>;
}

/**
 * The categories a picker offers, in tree order with their depth: `allowed` (names; Uncategorized and
 * names the tree does not know go last), without hidden categories except the current `value`.
 */
export function categoryChoices(tree: CategoryTree | null, allowed: readonly string[], value?: string | null): Array<{ name: string; depth: number }> {
  // Long lists show one picker per row: the same inputs give the same (cached) answer.
  const cacheKey = `${allowed.join("\u0001")}\u0002${value ?? ""}`;
  const cache = tree ? CHOICES.get(tree) ?? new Map<string, Array<{ name: string; depth: number }>>() : null;
  if (tree && cache) CHOICES.set(tree, cache);
  const cached = cache?.get(cacheKey);
  if (cached) return cached;
  const result = computeChoices(tree, allowed, value);
  if (cache && cache.size < 500) cache.set(cacheKey, result);
  return result;
}

const CHOICES = new WeakMap<CategoryTree, Map<string, Array<{ name: string; depth: number }>>>();

function computeChoices(tree: CategoryTree | null, allowed: readonly string[], value?: string | null): Array<{ name: string; depth: number }> {
  const wanted = new Set(allowed.map((name) => name.toLowerCase()));
  const listed = tree ? tree.flatten({ keep: value ?? null }).filter((node) => wanted.has(node.name.toLowerCase())).map((node) => ({ name: node.name, depth: node.depth })) : [];
  const seen = new Set(listed.map((item) => item.name.toLowerCase()));
  const hidden = new Set(tree ? tree.flatten({ includeHidden: true }).filter((node) => !seen.has(node.name.toLowerCase())).map((node) => node.name.toLowerCase()) : []);
  const rest = allowed.filter((name) => !seen.has(name.toLowerCase()) && (!hidden.has(name.toLowerCase()) || name === value)).map((name) => ({ name, depth: 0 }));
  const out = [...listed, ...rest];
  if (value && !out.some((item) => item.name === value)) out.push({ name: value, depth: 0 });
  return out;
}

/** An option label indented by its depth in the tree (non-breaking spaces, so screen readers read the name). */
export const indented = (label: string, depth: number) => `${"\u00a0\u00a0\u00a0".repeat(depth)}${label}`;

/**
 * A category picker: the whole tree, indented, without hidden categories (unless one is the current value).
 * `lazy` (a long list with one picker per row): until the picker is focused or touched it holds only the
 * current value, so hundreds of rows don't each build the whole tree.
 */
export function CategorySelect({ value, categories, label, onChange, tree, lazy = false }: { value: Category; categories: readonly Category[]; label: string; onChange: (category: Category) => void; tree?: CategoryTree | null; lazy?: boolean }) {
  const { m } = useI18n();
  const contextTree = useOptionalCategoryTree();
  const [engaged, setEngaged] = useState(!lazy);
  const engage = () => { if (!engaged) setEngaged(true); };
  const all = categoryChoices(tree ?? contextTree, categories, value);
  const options = engaged ? all : all.filter((option) => option.name === value);
  // The same option elements for every picker with the same choices: React skips them when nothing changed.
  const elements = useMemo(() => options.map((option) => <option key={option.name} value={option.name}>{indented(categoryLabel(m, option.name), option.depth)}</option>), [options, m]);
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onFocus={engage} onPointerDown={engage} onMouseDown={engage} onTouchStart={engage} onKeyDown={engage}>
      {elements}
    </select>
  );
}

const PRESETS: Array<Exclude<PeriodPreset, "custom">> = ["all_time", "this_month", "last_month", "last_30_days", "this_year", "last_year"];

export function PeriodPicker({ value, onChange }: { value: PeriodPreset; onChange: (preset: PeriodPreset) => void }) {
  const { m } = useI18n();
  return (
    <div className="bw-segmented" role="group" aria-label={m.periods.label}>
      {PRESETS.map((preset) => (
        <button key={preset} type="button" className={value === preset ? "is-active" : ""} aria-pressed={value === preset} onClick={() => onChange(preset)}>
          {m.periods[preset]}
        </button>
      ))}
    </div>
  );
}

export function PageHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  const heading = useFocusWhenLost<HTMLHeadingElement>(title);
  return (
    <header className="bw-page-heading">
      <div>
        <span className="bw-eyebrow">{eyebrow}</span>
        <h1 ref={heading} tabIndex={-1}>{title}</h1>
      </div>
      {children}
    </header>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="bw-empty">
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

/** A question shown in place. Focus moves into it, Escape cancels, and focus returns when it closes. */
export function InlineDialog({ role = "dialog", label, className, onCancel, children }: { role?: "dialog" | "alertdialog"; label: string; className: string; onCancel: () => void; children: ReactNode }) {
  const panel = useOpenedPanel<HTMLDivElement>();
  return (
    <div ref={panel} className={className} role={role} aria-label={label} tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }}>
      {children}
    </div>
  );
}

/** The app's own "are you sure" for something that cannot be undone. (`window.confirm` is asynchronous in the apps.) */
export function ConfirmDelete({ question, action, onConfirm, onCancel }: { question: string; action: string; onConfirm: () => void; onCancel: () => void }) {
  const { m } = useI18n();
  const id = useId();
  const panel = useOpenedPanel<HTMLDivElement>((element) => element.querySelector<HTMLElement>("[data-safe]"));
  return (
    <div ref={panel} className="bw-confirm" role="alertdialog" aria-labelledby={id} tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }}>
      <p id={id}>{question}</p>
      <button type="button" className="bw-button bw-button-danger" onClick={onConfirm}>{action}</button>
      <button type="button" className="bw-link-button" data-safe onClick={onCancel}>{m.ledger.common.cancel}</button>
    </div>
  );
}
