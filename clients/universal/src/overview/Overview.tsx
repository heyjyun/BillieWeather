import { useFocusWhenLost } from "../hooks/useFocus";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PRESETS, resolvePeriod } from "@billie/finance-core";
import { icons, type IconName } from "@billie/design-tokens";
import type { PeriodPreset } from "@billie/shared-types";
import { Breakdown, Trend, type Formats } from "./charts";
import { Editor, useLayout, type Copy } from "./layout";
import {
  dateMs,
  groupBalance,
  position,
  previous,
  shift,
  totals,
  type Action,
  type Host,
  type Metric,
  type Projection,
  type Scope,
  type Widget,
  type Bill,
} from "./model";
import messages from "./messages.json";
import "./overview.css";

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={icons[name]} />
    </svg>
  );
}
function useResource<T>(load: () => Promise<T>, enabled: boolean) {
  const [attempt, retry] = useState(0);
  const [result, set] = useState<{ load: typeof load; value?: T; error?: boolean }>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    set(undefined);
    Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (live) set({ load, value });
        },
        () => {
          if (live) set({ load, error: true });
        },
      );
    return () => {
      live = false;
    };
  }, [load, enabled, attempt]);
  return {
    value: result?.load === load ? result.value : undefined,
    error: result?.load === load && result.error,
    retry: () => retry((a) => a + 1),
  };
}
interface Status {
  value: unknown;
  error?: boolean;
  retry: () => void;
}
function Waiting({ r, c }: { r: Status; c: Copy }) {
  return r.error ? (
    <div className="fo-empty" role="alert">
      {c.error}{" "}
      <button className="fo-link" onClick={r.retry}>
        {c.retry}
      </button>
    </div>
  ) : (
    <p className="fo-empty" role="status">
      {c.loading}
    </p>
  );
}
class Boundary extends Component<{ c: Copy; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert">
        {this.props.c.error} <button onClick={() => this.setState({ failed: false })}>{this.props.c.retry}</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function WidgetCard({
  id,
  c,
  action,
  r,
  children,
  footer,
}: {
  id: Widget;
  c: Copy;
  action?: ReactNode;
  r: Status;
  children: () => ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section data-widget={id} aria-labelledby={"overview-" + id} className="fo-card">
      <header>
        <h2 id={"overview-" + id}>{c[id]}</h2>
        {action}
      </header>
      {r.value === undefined ? <Waiting r={r} c={c} /> : <RenderBody render={children} />}
      {footer && <footer className="fo-recent-actions">{footer}</footer>}
    </section>
  );
}
function RenderBody({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}
function Forecast({
  points,
  bills,
  c,
  fmt,
  today,
}: {
  points: Projection[];
  bills: Bill[];
  c: Copy;
  fmt: Formats;
  today: string;
}) {
  const [h, setH] = useState(30);
  if (!points.length) return <p className="fo-empty">{c.emptyForecast}</p>;
  const rows = points.slice(0, h + 1),
    last = rows.at(-1)!,
    shortage = rows.slice(1).find((p) => p.balance < 0);
  const movement = bills.filter((b) => b.date <= last.date).sort((a, b) => b.amount - a.amount)[0];
  const min = Math.min(...rows.map((r) => r.balance)),
    max = Math.max(...rows.map((r) => r.balance));
  const y = (n: number) => 46 - ((n - min) / (max - min || 1)) * 38;
  return (
    <>
      <div role="group" aria-label={c.forecast} className="fo-segments">
        {[30, 60, 90].map((n) => (
          <button key={n} aria-pressed={n === h} onClick={() => setH(n)}>
            {c.days.replace("{n}", String(n))}
          </button>
        ))}
      </div>
      <div className="fo-projection">
        <div>
          <small>
            {c.projection} · {fmt.date(last.date)}
          </small>
          <strong>{fmt.money(last.balance)}</strong>
        </div>
        <svg viewBox="0 0 126 54" role="img" aria-label={c.projection}>
          <polyline points={rows.map((r, i) => 3 + (i / h) * 120 + "," + y(r.balance)).join(" ")} />
          <circle cx="3" cy={y(rows[0].balance)} r="3" />
        </svg>
      </div>
      {shortage && (
        <p className="fo-shortage">
          {c.shortage} · {fmt.date(shortage.date)}
        </p>
      )}
      {movement && (
        <p className="fo-movement">
          {c.movement} · {movement.name} · {fmt.money(movement.amount)} · {fmt.date(movement.date)}
        </p>
      )}
      <small>
        {c.asOf} {fmt.date(today)} · {c.estimate}
      </small>
    </>
  );
}

function MetricCard({
  id,
  value,
  note,
  r,
  c,
  fmt,
  onOpen,
}: {
  id: Metric;
  value: number | null | undefined;
  note: string;
  r: Status;
  c: Copy;
  fmt: Formats;
  onOpen: () => void;
}) {
  const icon: IconName =
    (
      {
        worth: "layers",
        available: "wallet",
        income: "chart",
        expenses: "transactions",
        budget: "target",
        due: "repeat",
      } as Partial<Record<Metric, IconName>>
    )[id] ?? "chart";
  return (
    <article className={"fo-metric metric-" + id} id={"dashboard-" + id} key={id}>
      <button onClick={onOpen}>
        <span>
          <Icon name={icon} />
          {c[id]}
        </span>
        <strong aria-label={value == null ? c.missing : undefined}>
          {value == null ? "—" : id === "savings" ? fmt.percent(value) : fmt.money(value)}
        </strong>
      </button>
      {r.error ? <Waiting r={r} c={c} /> : <small>{r.value === undefined ? c.loading : note}</small>}
    </article>
  );
}
function ScopeToolbar({
  ctx,
  scope,
  c,
  preset,
  periodChoice,
  update,
  switchLedger,
  onError,
}: {
  ctx: Host["context"];
  scope: Scope;
  c: Copy;
  preset: PeriodPreset;
  periodChoice: (preset: PeriodPreset) => void;
  update: (scope: Scope) => void;
  switchLedger: Host["switchLedger"];
  onError: (failed: boolean) => void;
}) {
  const [switching, setSwitching] = useState(false);
  return (
    <div className="fo-toolbar">
      <label>
        {c.ledger}
        <select
          aria-label={c.ledger}
          value={ctx.ledger}
          disabled={ctx.ledgers.length < 2 || switching}
          onChange={async (e) => {
            setSwitching(true);
            onError(false);
            try {
              await switchLedger?.(e.target.value);
            } catch {
              onError(true);
            } finally {
              setSwitching(false);
            }
          }}
        >
          {ctx.ledgers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {c.account}
        <select
          aria-label={c.account}
          value={scope.account}
          onChange={(e) => {
            const account = e.target.value;
            update({
              ...scope,
              account,
              currency: ctx.accounts.find((a) => a.id === account)?.currency ?? scope.currency,
            });
          }}
        >
          <option value="">{c.allAccounts}</option>
          {ctx.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {c.currency}
        <select
          aria-label={c.currency}
          value={scope.currency}
          disabled={ctx.currencies.length < 2}
          onChange={(e) => update({ ...scope, currency: e.target.value, account: "" })}
        >
          {ctx.currencies.map((code) => (
            <option key={code}>{code}</option>
          ))}
        </select>
      </label>
      <label>
        {c.range}
        <select aria-label={c.range} value={preset} onChange={(e) => periodChoice(e.target.value as PeriodPreset)}>
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {c[p]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function Overview(host: Host) {
  const { context: ctx } = host;
  const heading = useFocusWhenLost<HTMLHeadingElement>();
  const c = messages[ctx.locale as keyof typeof messages] ?? messages.en;
  const [scope, setScope] = useState<Scope>(
    () =>
      ctx.initial ?? {
        account: "",
        currency: ctx.currency,
        period: resolvePeriod("all_time", { today: ctx.today }),
      },
  );
  const [preset, setPreset] = useState<PeriodPreset>(scope.period.preset);
  const [dates, setDates] = useState({
    startDate: scope.period.startDate ?? "",
    endDate: scope.period.endDate ?? "",
  });
  const [invalid, setInvalid] = useState(false);
  const [switchError, setSwitchError] = useState(false);
  const { layout, save, failed } = useLayout(ctx.owner);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const src = useMemo(() => host.sources(scope), [host.sources, scope]);
  const shown = (id: Widget) => id === host.focusWidget || !layout.hidden.includes(id);
  useEffect(() => {
    if (host.focusWidget) document.querySelector('[data-widget="' + host.focusWidget + '"]')?.scrollIntoView?.({ block: "start" });
  }, [host.focusWidget]);
  const has = (...ids: Metric[]) => ids.some((id) => layout.cards.includes(id));
  const flow = useResource(src.flow, shown("trend") || has("income", "expenses", "net", "savings"));
  const balances = useResource(
    src.position,
    shown("accounts") || has("worth", "available", "assets", "liabilities", "fixed"),
  );
  const parts = useResource(src.spending, shown("spending"));
  const recent = useResource(src.recent, shown("recent"));
  const bills = useResource(src.bills, shown("bills") || shown("forecast") || has("due"));
  const budget = useResource(src.budget, has("budget"));
  const insight = useResource(src.insight, shown("insight"));
  const forecast = useResource(src.forecast, shown("forecast"));
  const fmt = useMemo<Formats>(() => {
    const currency = new Intl.NumberFormat(ctx.locale, { style: "currency", currency: scope.currency });
    const compact = new Intl.NumberFormat(ctx.locale, { notation: "compact", maximumFractionDigits: 1 });
    const percent = new Intl.NumberFormat(ctx.locale, { style: "percent", maximumFractionDigits: 1 });
    return {
      money: (n) => currency.format(n / 100),
      axis: (n) => compact.format(n / 100),
      percent: (n) => percent.format(n),
      date: (s, options = { year: "numeric", month: "short", day: "numeric" }) =>
        new Intl.DateTimeFormat(ctx.locale, { ...options, timeZone: "UTC" }).format(dateMs(s)),
    };
  }, [scope.currency, ctx.locale]);
  function update(next: Scope) {
    setScope(next);
    host.scopeChanged?.(next);
  }
  function periodChoice(p: PeriodPreset) {
    setPreset(p);
    setInvalid(false);
    if (p === "custom") {
      setDates({ startDate: scope.period.startDate ?? ctx.today, endDate: scope.period.endDate ?? ctx.today });
      return;
    }
    update({ ...scope, period: resolvePeriod(p, { today: ctx.today }) });
  }
  const action = (id: Action, label: string, category?: string) => (
    <button type="button" className="fo-link" onClick={() => host.navigate(id, scope, category)}>
      {label} <span aria-hidden="true">↗</span>
    </button>
  );
  const active = scope.period;
  const periodLabel =
    active.startDate && active.endDate
      ? fmt.date(active.startDate) + " – " + fmt.date(active.endDate)
      : c.all_time;
  const pos = balances.value && position(balances.value);
  const current = flow.value && totals(flow.value, active);
  const prev = previous(active);
  const prior = flow.value && prev && totals(flow.value, prev);
  const coming = bills.value?.filter((b) => b.date <= shift(ctx.today, 29));
  const close = () => {
    setEditing(false);
    editButton.current?.focus();
  };
  function metric(id: Metric) {
    let value: number | null | undefined, note: string, go: Action, r: Status;
    if (id === "income" || id === "expenses" || id === "net" || id === "savings") {
      r = flow;
      value = current?.[id];
      go = "transactions";
      note = c.inPeriod;
      if (id !== "savings" && prior && current) {
        const diff = current[id] - prior[id];
        note = (diff > 0 ? "+" : "") + fmt.money(diff) + " " + c.versus;
      }
    } else if (id === "budget") {
      r = budget;
      value = budget.value;
      go = "budget";
      note = c.monthlyBudget;
    } else if (id === "due") {
      r = bills;
      value = coming?.length ? coming.reduce((s, b) => s + b.amount, 0) : null;
      go = "bills";
      note = c.next30;
    } else {
      r = balances;
      value = pos?.[id];
      go = "accounts";
      note = c.asOf + " " + fmt.date(ctx.today);
    }
    const activity =
      go === "transactions"
        ? id === "income"
          ? "income"
          : id === "expenses"
            ? "spending"
            : "counted"
        : undefined;
    return (
      <MetricCard
        key={id}
        id={id}
        value={value}
        note={note}
        r={r}
        c={c}
        fmt={fmt}
        onOpen={() => host.navigate(go, scope, undefined, activity)}
      />
    );
  }
  const cards: Record<Widget, ReactNode> = {
    trend: (
      <WidgetCard
        id="trend"
        c={c}
        r={flow}
        action={
          scope.account || ctx.currencies.length > 1 || (host.switchLedger && active.preset !== "all_time")
            ? action("transactions", c.transactions)
            : action("report", c.report)
        }
      >
        {() => <Trend days={flow.value!} scope={scope} c={c} fmt={fmt} />}
      </WidgetCard>
    ),
    spending: (
      <WidgetCard id="spending" c={c} r={parts} action={action("categories", c.categories)}>
        {() => (
          <Breakdown
            parts={parts.value!}
            c={c}
            fmt={fmt}
            open={(name) => host.navigate("transactions", scope, name, "spending")}
          />
        )}
      </WidgetCard>
    ),
    forecast: (
      <WidgetCard
        id="forecast"
        c={c}
        r={forecast}
        action={
          host.switchLedger || scope.account || ctx.currencies.length > 1
            ? undefined
            : action("forecast", c.openForecast)
        }
      >
        {() => <Forecast points={forecast.value!} bills={bills.value ?? []} today={ctx.today} c={c} fmt={fmt} />}
      </WidgetCard>
    ),
    accounts: (
      <WidgetCard id="accounts" c={c} r={balances} action={action("accounts", c.manage)}>
        {() =>
          !balances.value!.holdings.length &&
          balances.value!.extraCash === null &&
          balances.value!.cashOverride === null ? (
            <div className="fo-empty">
              {c.emptyAccounts}
              <div>{action("addAccount", c.addAccount)}</div>
            </div>
          ) : (
            <dl className="fo-values">
              {(["liquid", "financial", "fixed", "liabilities", "other"] as const).map((key) => {
                const n = groupBalance(balances.value!, key);
                return (
                  <div key={key}>
                    <dt>{c[key]}</dt>
                    <dd>{n === null ? "—" : fmt.money(n)}</dd>
                  </div>
                );
              })}
            </dl>
          )
        }
      </WidgetCard>
    ),
    bills: (
      <WidgetCard id="bills" c={c} r={bills} action={action("bills", c.manage)}>
        {() =>
          coming?.length ? (
            <ul className="fo-list">
              {coming.slice(0, 5).map((b, i) => (
                <li key={i}>
                  <div>
                    <b>{b.name}</b>
                    <small>
                      {fmt.date(b.date)} · {b.account}
                    </small>
                  </div>
                  <strong>{fmt.money(b.amount)}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fo-empty">{c.emptyBills}</p>
          )
        }
      </WidgetCard>
    ),
    recent: (
      <WidgetCard
        id="recent"
        c={c}
        r={recent}
        action={action("transactions", c.transactions)}
        footer={action("addSync", c.addSync)}
      >
        {() => (
          <>
            {recent.value!.length ? (
              <ul className="fo-list">
                {recent.value!.map((r) => (
                  <li key={r.id}>
                    <div>
                      <b>{r.name}</b>
                      <small>{[fmt.date(r.date), r.category, r.account].filter(Boolean).join(" · ")}</small>
                    </div>
                    <strong className={r.amount > 0 ? "fo-positive" : ""}>{fmt.money(r.amount)}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="fo-empty">
                {c.emptyFlow}
                <div>
                  {action("addEntry", c.addEntry)} {action("import", c.import)}
                </div>
              </div>
            )}
          </>
        )}
      </WidgetCard>
    ),
    insight: (
      <WidgetCard id="insight" c={c} r={insight} action={action("insight", c.openAI)}>
        {() =>
          insight.value ? (
            <>
              <p>{insight.value.text}</p>
              <small>{fmt.date(insight.value.date)}</small>
            </>
          ) : (
            <p className="fo-empty">{c.emptyAI}</p>
          )
        }
      </WidgetCard>
    ),
  };
  return (
    <div className="fo-dashboard">
      <header className="fo-title">
        <div>
          <h1 tabIndex={host.switchLedger ? -1 : undefined} ref={host.switchLedger ? heading : undefined}>
            {c.title}
          </h1>
          <p>
            {ctx.greeting && (
              <>
                {ctx.greeting} <span>·</span>{" "}
              </>
            )}
            {periodLabel} <span>·</span> {scope.currency}
          </p>
        </div>
        <button
          className="fo-customize"
          ref={editButton}
          aria-expanded={editing}
          aria-controls="overview-editor"
          onClick={() => setEditing(!editing)}
        >
          <Icon name="settings" />
          {c.customize}
        </button>
      </header>
      <div className="bw-next-slot" data-next-slot />
      <ScopeToolbar
        ctx={ctx}
        scope={scope}
        c={c}
        preset={preset}
        periodChoice={periodChoice}
        update={update}
        switchLedger={host.switchLedger}
        onError={setSwitchError}
      />
      {preset === "custom" && (
        <form
          className="fo-dates"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              update({ ...scope, period: resolvePeriod("custom", { today: ctx.today, ...dates }) });
              setInvalid(false);
            } catch {
              setInvalid(true);
            }
          }}
        >
          <label>
            {c.start}
            <input
              type="date"
              required
              value={dates.startDate}
              onChange={(e) => setDates({ ...dates, startDate: e.target.value })}
            />
          </label>
          <label>
            {c.end}
            <input
              type="date"
              required
              value={dates.endDate}
              onChange={(e) => setDates({ ...dates, endDate: e.target.value })}
            />
          </label>
          <button>{c.apply}</button>
        </form>
      )}
      {invalid && <p role="alert">{c.invalid}</p>}
      {switchError && <p role="alert">{c.error}</p>}
      {editing && <Editor c={c} layout={layout} save={save} close={close} />}{" "}
      {failed && <p role="alert">{c.saveError}</p>}
      <div className="fo-metrics">{layout.cards.map(metric)}</div>
      <div className="fo-widgets">
        {layout.order.filter(shown).map((id) => (
          <div key={id} className={layout.wide.includes(id) ? "fo-wide" : ""}>
            <Boundary key={JSON.stringify(scope)} c={c}>
              {cards[id]}
            </Boundary>
          </div>
        ))}
      </div>
    </div>
  );
}
