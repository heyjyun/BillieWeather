import type { Category, PeriodPreset } from "@billie/shared-types";
import { formatMoney } from "@billie/finance-core";
import type { ReactNode } from "react";

export function Money({ cents, currency, signed = false }: { cents: number; currency: string; signed?: boolean }) {
  const tone = signed ? (cents > 0 ? "bw-positive" : cents < 0 ? "bw-negative" : "") : "";
  return <span className={`bw-money ${tone}`}>{signed && cents > 0 ? "+" : ""}{formatMoney(cents, currency)}</span>;
}

const CATEGORY_TONES: Record<Category, string> = {
  Income: "green", Housing: "blue", "Food & dining": "orange", Transport: "purple", Utilities: "teal",
  Shopping: "pink", Health: "red", Business: "gold", Transfers: "gray", Uncategorized: "gray",
};

export function CategoryBadge({ category }: { category: Category }) {
  return <span className={`bw-category bw-tone-${CATEGORY_TONES[category]}`}>{category}</span>;
}

export const PERIOD_LABELS: Record<Exclude<PeriodPreset, "custom">, string> = {
  all_time: "All time", this_month: "This month", last_month: "Last month", last_30_days: "Last 30 days", this_year: "This year", last_year: "Last year",
};

export function PeriodPicker({ value, onChange }: { value: PeriodPreset; onChange: (preset: PeriodPreset) => void }) {
  return (
    <div className="bw-segmented" role="group" aria-label="Date range">
      {(Object.keys(PERIOD_LABELS) as Array<keyof typeof PERIOD_LABELS>).map((preset) => (
        <button key={preset} type="button" className={value === preset ? "is-active" : ""} aria-pressed={value === preset} onClick={() => onChange(preset)}>
          {PERIOD_LABELS[preset]}
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
