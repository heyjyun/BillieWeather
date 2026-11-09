import type { BuiltInCategory, Category, PeriodPreset } from "@billie/shared-types";
import { formatMoney } from "@billie/finance-core";
import type { ReactNode } from "react";
import { categoryLabel, useI18n } from "../i18n";

export function Money({ cents, currency, signed = false }: { cents: number; currency: string; signed?: boolean }) {
  const tone = signed ? (cents > 0 ? "bw-positive" : cents < 0 ? "bw-negative" : "") : "";
  return <span className={`bw-money ${tone}`}>{signed && cents > 0 ? "+" : ""}{formatMoney(cents, currency)}</span>;
}

const CATEGORY_TONES: Record<BuiltInCategory, string> = {
  Income: "green", Housing: "blue", "Food & dining": "orange", Transport: "purple", Utilities: "teal",
  Shopping: "pink", Health: "red", Business: "gold", Transfers: "gray", Uncategorized: "gray",
};

export function CategoryBadge({ category }: { category: Category }) {
  const { m } = useI18n();
  const tone = Object.prototype.hasOwnProperty.call(CATEGORY_TONES, category) ? CATEGORY_TONES[category as BuiltInCategory] : "slate";
  return <span className={`bw-category bw-tone-${tone}`}>{categoryLabel(m, category)}</span>;
}

/** A category picker offering the built-in categories and the person's own. */
export function CategorySelect({ value, categories, label, onChange }: { value: Category; categories: readonly Category[]; label: string; onChange: (category: Category) => void }) {
  const { m } = useI18n();
  const options = categories.includes(value) ? categories : [...categories, value];
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((c) => <option key={c} value={c}>{categoryLabel(m, c)}</option>)}
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
  return (
    <header className="bw-page-heading">
      <div>
        <span className="bw-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
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
