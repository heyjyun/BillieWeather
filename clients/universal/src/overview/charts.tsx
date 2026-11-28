import { useEffect, useMemo, useRef, useState } from "react";
import { buckets, dateMs, scaleFor, type Day, type Part, type Scale, type Scope } from "./model";
import type { Copy } from "./layout";
export interface Formats {
  money: (cents: number) => string;
  date: (s: string, options?: Intl.DateTimeFormatOptions) => string;
  percent: (n: number) => string;
  axis: (n: number) => string;
}
const series = ["income", "expenses", "net"] as const;
export function Trend({ days, scope, c, fmt }: { days: Day[]; scope: Scope; c: Copy; fmt: Formats }) {
  const frame = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(888);
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w > 0) setPlotWidth(Math.max(240, w));
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [days]);
  const [choice, setChoice] = useState<Scale | null>(null);
  const scale = choice ?? scaleFor(days, scope.period);
  const rows = useMemo(() => buckets(days, scope.period, scale), [days, scope.period, scale]);
  const [index, setIndex] = useState<number | null>(null);
  const active = index === null ? null : rows[index];
  if (!rows.length) return <p className="fo-empty">{c.emptyFlow}</p>;
  const low = rows.reduce((n, r) => Math.min(n, r.income, r.expenses, r.income - r.expenses), 0);
  const high = rows.reduce((n, r) => Math.max(n, r.income, r.expenses, r.income - r.expenses), 0);
  const left = 48,
    right = plotWidth - 25,
    top = 14,
    bottom = 146;
  const y = (n: number) => bottom - ((n - low) / (high - low || 1)) * (bottom - top);
  const first = dateMs(rows[0].date),
    last = dateMs(rows[rows.length - 1].date);
  const x = (date: string) =>
    last === first
      ? (left + right) / 2
      : left + 12 + ((dateMs(date) - first) / (last - first)) * (right - left - 24);
  const label = (date: string) =>
    fmt.date(
      date,
      scale === "yearly"
        ? { year: "numeric" }
        : scale === "monthly"
          ? { month: "short", year: "2-digit" }
          : { month: "short", day: "numeric" },
    );
  const interval = scale === "yearly" ? 365 : scale === "monthly" ? 28 : scale === "weekly" ? 7 : 1;
  const width = Math.min(
    13,
    Math.max(0.8, (((right - left - 24) * interval * 86400000) / (last - first || 86400000)) * 0.28),
  );
  const line = rows.map((r) => x(r.date) + "," + y(r.income - r.expenses)).join(" ");
  const ticks = [...new Set(Array.from({ length: 5 }, (_, i) => Math.round(((rows.length - 1) * i) / 4)))];
  return (
    <div ref={frame} className="fo-trend">
      <div className="fo-chart-controls">
        <div className="fo-legend">
          {series.map((key) => (
            <span key={key}>
              <i className={"fo-key " + key} />
              {c[key]}
            </span>
          ))}
        </div>
        <select
          aria-label={c.aggregation}
          value={scale}
          onChange={(e) => {
            setChoice(e.target.value as Scale);
            setIndex(null);
          }}
        >
          {(["daily", "weekly", "monthly", "yearly"] as const).map((s) => (
            <option key={s} value={s}>
              {c[s]}
            </option>
          ))}
        </select>
      </div>
      <svg
        role="img"
        aria-label={c.trend}
        viewBox={"0 0 " + plotWidth + " 174"}
        className="fo-plot"
        onMouseLeave={() => setIndex(null)}
        onMouseMove={(e) => {
          const svg = e.currentTarget,
            matrix = svg.getScreenCTM();
          if (!matrix) return;
          const point = svg.createSVGPoint();
          point.x = e.clientX;
          point.y = e.clientY;
          const at = point.matrixTransform(matrix.inverse()).x;
          let best = 0;
          for (let i = 1; i < rows.length; i++)
            if (Math.abs(x(rows[i].date) - at) < Math.abs(x(rows[best].date) - at)) best = i;
          setIndex(best);
        }}
      >
        {(high === low ? [0] : [0, 1, 2, 3]).map((i) => {
          const v = low + ((high - low) * i) / 3;
          return (
            <g key={i}>
              <line className="fo-gridline" x1={left} x2={right + 10} y1={y(v)} y2={y(v)} />
              <text x={left - 8} y={y(v) + 4} textAnchor="end">
                {fmt.axis(v)}
              </text>
            </g>
          );
        })}
        {rows.map((r) => (
          <g key={r.date}>
            {(["income", "expenses"] as const).map((key, i) => (
              <rect
                key={key}
                className={"fo-bar " + key}
                x={x(r.date) + (i ? 1 : -width - 1)}
                y={Math.min(y(0), y(r[key]))}
                width={width}
                height={Math.abs(y(r[key]) - y(0))}
                rx={Math.min(width / 3, 2)}
              />
            ))}
          </g>
        ))}
        <polyline className="fo-netline" points={line} />
        {rows.length < 28 &&
          rows.map((r) => (
            <circle className="fo-dot" key={r.date} cx={x(r.date)} cy={y(r.income - r.expenses)} r="2.6" />
          ))}
        {active && <line className="fo-cross" x1={x(active.date)} x2={x(active.date)} y1={top} y2={bottom} />}
        {ticks.map((i) => (
          <text key={i} x={x(rows[i].date)} y="168" textAnchor="middle">
            {label(rows[i].date)}
          </text>
        ))}
      </svg>
      <label className="fo-scrub">
        <span>{active ? label(active.date) : c.history}</span>
        <input
          type="range"
          min="0"
          max={rows.length - 1}
          value={index ?? rows.length - 1}
          aria-label={c.history}
          aria-valuetext={label(rows[index ?? rows.length - 1]?.date ?? rows[0].date)}
          onFocus={() => setIndex(index ?? rows.length - 1)}
          onChange={(e) => setIndex(+e.target.value)}
        />
      </label>
      {active && (
        <output className="fo-tooltip">
          {series.map((k) => (
            <span key={k}>
              {c[k]} <b>{fmt.money(k === "net" ? active.income - active.expenses : active[k])}</b>
            </span>
          ))}
        </output>
      )}
    </div>
  );
}

export function Breakdown({
  parts,
  c,
  fmt,
  open,
}: {
  parts: Part[];
  c: Copy;
  fmt: Formats;
  open: (name: string) => void;
}) {
  const [focus, setFocus] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const grouped = new Map<string, { name: string; label: string; amount: number; children: boolean }>();
  for (const part of parts) {
    if (!focus.every((n, i) => part.path[i]?.name === n)) continue;
    const next = part.path[focus.length] ?? part.path.at(-1);
    if (!next) continue;
    const row = grouped.get(next.name) ?? { ...next, amount: 0, children: false };
    row.amount += part.amount;
    row.children ||= part.path.length > focus.length + 1;
    grouped.set(row.name, row);
  }
  const rows = [...grouped.values()].filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount);
  const largest = rows.reduce((n, r) => Math.max(n, Math.abs(r.amount)), 1);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <div>
      {focus.length > 0 && (
        <button
          className="fo-link"
          onClick={() => {
            setFocus(focus.slice(0, -1));
            setAll(false);
          }}
        >
          ‹ {c.back}
        </button>
      )}
      {!rows.length && <p className="fo-empty">{c.emptySpend}</p>}
      <ul className="fo-breakdown">
        {shown.map((r, i) => (
          <li key={r.name}>
            <div>
              <button
                className="fo-text"
                onClick={() => (r.children ? (setFocus([...focus, r.name]), setAll(false)) : open(r.name))}
              >
                {r.label}
                {r.children && " ›"}
              </button>
              <small>{total > 0 ? fmt.percent(r.amount / total) : "—"}</small>
              <b>{fmt.money(r.amount)}</b>
            </div>
            <div className="fo-track">
              <i
                style={{
                  width: (Math.abs(r.amount) / largest) * 100 + "%",
                  background: "var(--fo-tone-" + (i % 5) + ")",
                }}
              />
            </div>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <button className="fo-link" onClick={() => setAll(true)}>
          {c.more} ({rows.length})
        </button>
      )}
      {focus.length > 0 && (
        <button className="fo-link" onClick={() => open(focus[focus.length - 1])}>
          {c.transactions} ↗
        </button>
      )}
    </div>
  );
}
