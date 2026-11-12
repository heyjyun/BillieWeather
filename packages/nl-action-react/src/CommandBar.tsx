// A compact, keyboard-driven natural-language command bar. Unstyled apart from layout: colors,
// type and spacing come from the host through --nlae-* custom properties (see commandBar.css).

import { isYes, type ActionPlan, type ArgumentValue, type ClarificationOption, type DateRangeValue, type ExecutionResult, type Message, type MoneyValue, type ParamSpec, type PlanArgument } from "@nlae/core";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CommandController } from "./controller";

export interface CommandBarLabels {
  inputLabel: string;
  placeholder: string;
  submit: string;
  suggestions: string;
  working: string;
  confirm: string;
  cancel: string;
  undo: string;
  dismiss: string;
  typeToConfirm: string;
  notes: string;
  changes: string;
  moreChanges: string;
  noChanges: string;
  unsupported: string;
  tryThese: string;
  answerHint: string;
  cancelled: string;
  undone: string;
  riskNone: string;
  riskLow: string;
  riskMedium: string;
  riskHigh: string;
  from: string;
  to: string;
  notSet: string;
  yes: string;
  no: string;
}

export const DEFAULT_LABELS: CommandBarLabels = {
  inputLabel: "Command", placeholder: "Type a command, e.g. “show coffee last month”", submit: "Go", suggestions: "Suggestions", working: "Working…",
  confirm: "Confirm", cancel: "Cancel", undo: "Undo", dismiss: "Dismiss", typeToConfirm: "Type {phrase} to confirm", notes: "Assumptions and corrections",
  changes: "{count} change(s)", moreChanges: "…and {count} more", noChanges: "Nothing will change.", unsupported: "I can't do that yet.", tryThese: "Try:",
  answerHint: "Choose an option or type an answer.", cancelled: "Cancelled.", undone: "Undone.", riskNone: "View", riskLow: "Adds data", riskMedium: "Changes data",
  riskHigh: "Deletes data", from: "From", to: "To", notSet: "—", yes: "Yes", no: "No",
};

export interface CommandBarProps {
  controller: CommandController;
  labels?: Partial<CommandBarLabels>;
  /** Translates engine and host messages (by `code`); falls back to the English `message`. */
  format?: (message: Message) => string;
  /** Localized name of an action. */
  actionName?: (actionId: string) => string;
  /** Localized name of a parameter. */
  paramName?: (actionId: string, param: string) => string;
  /** Localized label of an enum/entity value. */
  valueLabel?: (actionId: string, param: string, value: string, fallback: string) => string;
  /** Ctrl/⌘+K focuses the bar. */
  hotkey?: boolean;
  onResult?: (result: ExecutionResult, plan: ActionPlan) => void;
  className?: string;
}

type View =
  | { kind: "idle"; status?: string }
  | { kind: "busy" }
  | { kind: "question"; plan: ActionPlan }
  | { kind: "unsupported"; plan: ActionPlan }
  | { kind: "preview"; plan: ActionPlan; summary?: Message }
  | { kind: "rejected"; plan: ActionPlan; message: Message }
  | { kind: "done"; plan: ActionPlan; result: ExecutionResult; undone?: boolean };

const fill = (text: string, vars: Record<string, string | number> = {}) => text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const PREVIEW_ROWS = 5;

export function CommandBar(props: CommandBarProps) {
  const { controller } = props;
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...props.labels }), [props.labels]);
  const format = useCallback((message: Message) => props.format?.(message) ?? fill(message.message, message.vars), [props.format]);
  const actionName = (id: string) => props.actionName?.(id) ?? controller.definition(id)?.description ?? id;
  const paramName = (id: string, param: string) => props.paramName?.(id, param) ?? param;
  const valueLabel = (id: string, param: string, value: string, fallback: string) => props.valueLabel?.(id, param, value, fallback) ?? fallback;

  const [text, setText] = useState("");
  const [view, setView] = useState<View>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-suggestions`;

  const suggestions = useMemo(() => (open ? controller.suggest(text) : []), [open, text, controller]);

  useEffect(() => {
    if (props.hotkey === false) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.hotkey]);

  const finish = useCallback((plan: ActionPlan, result: ExecutionResult) => {
    if (result.status === "succeeded") controller.remember(plan);
    props.onResult?.(result, plan);
    if (result.status === "rejected") setView({ kind: "rejected", plan, message: result.summary });
    else setView({ kind: "done", plan, result });
  }, [controller, props]);

  /** Ready plan → trusted preview → run directly (reads) or show the preview for confirmation. */
  const proceed = useCallback(async (plan: ActionPlan) => {
    if (plan.status === "cancelled") return setView({ kind: "idle", status: labels.cancelled });
    if (plan.status === "needs_clarification") return setView({ kind: "question", plan });
    if (plan.status !== "ready") return setView({ kind: "unsupported", plan });
    const preview = await controller.preview(plan);
    if (!preview.ok) return setView({ kind: "rejected", plan, message: preview.rejection!.summary });
    if (preview.plan.confirmation === "none") return finish(preview.plan, await controller.execute(preview.plan, { confirmed: false }));
    setTyped("");
    setView({ kind: "preview", plan: preview.plan });
  }, [controller, finish, labels.cancelled]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setView({ kind: "busy" });
    try {
      await work();
    } catch (error) {
      setView({ kind: "idle", status: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const submit = (value = text) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setOpen(false);
    if (view.kind === "preview" && view.plan.confirmation === "confirm" && isYes(trimmed)) {
      setText("");
      return confirm(view.plan);
    }
    setText("");
    void run(async () => proceed(await controller.submit(trimmed)));
  };

  const confirm = (plan: ActionPlan) => void run(async () => {
    const result = await controller.execute(plan, { confirmed: true, typed: plan.confirmation === "typed" ? typed : undefined });
    if (result.status === "rejected" && result.code === "stale_preview") {
      // The data changed since the preview: show the fresh one rather than guessing.
      const fresh = await controller.preview(plan);
      if (fresh.ok) return setView({ kind: "preview", plan: fresh.plan, summary: result.summary });
    }
    finish(plan, result);
  });

  const cancel = () => {
    controller.reset();
    setView({ kind: "idle", status: labels.cancelled });
    input.current?.focus();
  };

  const edit = (plan: ActionPlan, param: string, value: ArgumentValue | null) => void run(async () => proceed(await controller.edit(plan, { [param]: value })));

  const undo = (plan: ActionPlan, result: ExecutionResult) => void run(async () => {
    const outcome = await controller.undo(result.undo!.token);
    if (outcome.status === "succeeded") setView({ kind: "done", plan, result: { ...result, summary: { code: "undone", message: labels.undone }, undo: null }, undone: true });
    else setView({ kind: "rejected", plan, message: outcome.summary });
  });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && suggestions.length) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp" && suggestions.length) {
      event.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if ((event.key === "Tab" || event.key === "Enter") && open && active >= 0 && suggestions[active]) {
      event.preventDefault();
      setText(suggestions[active].text);
      setActive(-1);
      setOpen(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      if (open) setOpen(false);
      else if (view.kind !== "idle") cancel();
    }
  };

  return (
    <div className={`nlae ${props.className ?? ""}`.trim()}>
      <form className="nlae-form" role="search" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="nlae-visually-hidden" htmlFor={`${id}-input`}>{labels.inputLabel}</label>
        <input
          ref={input} id={`${id}-input`} className="nlae-input" type="text" autoComplete="off" spellCheck={false} value={text} placeholder={labels.placeholder}
          role="combobox" aria-autocomplete="list" aria-expanded={open && suggestions.length > 0} aria-controls={listId}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKeyDown}
        />
        <kbd className="nlae-hint" aria-hidden="true">⌘K</kbd>
        <button type="submit" className="nlae-button nlae-primary" disabled={!text.trim() || view.kind === "busy"}>{labels.submit}</button>
        {open && suggestions.length > 0 && (
          <ul className="nlae-suggestions" id={listId} role="listbox" aria-label={labels.suggestions}>
            {suggestions.map((s, i) => (
              <li key={`${s.actionId}-${s.text}`} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? "is-active" : ""}
                onMouseDown={(e) => { e.preventDefault(); setText(s.text); setOpen(false); input.current?.focus(); }}>
                <span>{s.text}</span><small>{actionName(s.actionId)}</small>
              </li>
            ))}
          </ul>
        )}
      </form>
      <div className="nlae-output" role="status" aria-live="polite">
        {view.kind === "idle" && view.status && <p className="nlae-muted">{view.status}</p>}
        {view.kind === "busy" && <p className="nlae-muted">{labels.working}</p>}
        {view.kind === "question" && (
          <Question plan={view.plan} format={format} labels={labels} valueLabel={valueLabel} actionName={actionName}
            onChoose={(index) => submit(view.plan.clarification?.kind === "confirmIntent" ? view.plan.clarification.options[index].value : String(index + 1))} onCancel={cancel} />
        )}
        {view.kind === "unsupported" && (
          <section className="nlae-panel">
            <p>{view.plan.issues[0] ? format(view.plan.issues[0]) : labels.unsupported}</p>
            <Examples controller={controller} plan={view.plan} labels={labels} onPick={(t) => { setText(t); input.current?.focus(); }} />
          </section>
        )}
        {view.kind === "rejected" && (
          <section className="nlae-panel nlae-warning">
            <p>{format(view.message)}</p>
            <button type="button" className="nlae-button" onClick={() => setView({ kind: "idle" })}>{labels.dismiss}</button>
          </section>
        )}
        {view.kind === "preview" && (
          <Preview plan={view.plan} summary={view.summary} controller={controller} labels={labels} format={format} actionName={actionName} paramName={paramName}
            valueLabel={valueLabel} typed={typed} setTyped={setTyped} onEdit={edit} onConfirm={confirm} onCancel={cancel} />
        )}
        {view.kind === "done" && (
          <section className={view.result.status === "succeeded" ? "nlae-panel nlae-success" : "nlae-panel nlae-warning"}>
            <p>{format(view.result.summary)}</p>
            <Notes plan={view.plan} labels={labels} format={format} />
            <div className="nlae-actions">
              {view.result.undo && !view.undone && <button type="button" className="nlae-button" onClick={() => undo(view.plan, view.result)}>{labels.undo}</button>}
              <button type="button" className="nlae-button" onClick={() => setView({ kind: "idle" })}>{labels.dismiss}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Notes({ plan, labels, format }: { plan: ActionPlan; labels: CommandBarLabels; format: (m: Message) => string }) {
  const notes = plan.notes.filter((n) => n.kind !== "script");
  if (!notes.length) return null;
  return (
    <div className="nlae-notes">
      <p className="nlae-label">{labels.notes}</p>
      <ul>{notes.map((n, i) => <li key={i}>{format(n)}</li>)}</ul>
    </div>
  );
}

function Question({ plan, format, labels, valueLabel, actionName, onChoose, onCancel }: {
  plan: ActionPlan; format: (m: Message) => string; labels: CommandBarLabels; actionName: (id: string) => string;
  valueLabel: (id: string, param: string, value: string, fallback: string) => string; onChoose: (index: number) => void; onCancel: () => void;
}) {
  const clarification = plan.clarification!;
  const label = (option: ClarificationOption) => {
    if (clarification.kind === "intent") return actionName(option.value);
    if (clarification.kind === "confirmIntent") return option.value === "yes" ? labels.yes : labels.no;
    if (clarification.param && plan.intent) return valueLabel(plan.intent.actionId, clarification.param, option.value, option.label);
    return option.label;
  };
  return (
    <section className="nlae-panel">
      <p><strong>{format(clarification)}</strong></p>
      {clarification.options.length > 0 && (
        <ol className="nlae-options">
          {clarification.options.map((option, index) => <li key={option.value}><button type="button" className="nlae-button" onClick={() => onChoose(index)}>{label(option)}</button></li>)}
        </ol>
      )}
      <p className="nlae-muted">{labels.answerHint}</p>
      <Notes plan={plan} labels={labels} format={format} />
      <div className="nlae-actions"><button type="button" className="nlae-button" onClick={onCancel}>{labels.cancel}</button></div>
    </section>
  );
}

function Examples({ controller, plan, labels, onPick }: { controller: CommandController; plan: ActionPlan; labels: CommandBarLabels; onPick: (text: string) => void }) {
  const near = plan.alternatives.map((a) => controller.definition(a.actionId)?.examples?.[0]).filter((t): t is string => Boolean(t));
  const examples = near.length ? near : controller.suggest("").map((s) => s.text).slice(0, 3);
  if (!examples.length) return null;
  return (
    <p className="nlae-muted">{labels.tryThese}{" "}
      {examples.map((example) => <button key={example} type="button" className="nlae-chip" onClick={() => onPick(example)}>{example}</button>)}
    </p>
  );
}

const RISK_KEY = { none: "riskNone", low: "riskLow", medium: "riskMedium", high: "riskHigh" } as const;

function Preview(props: {
  plan: ActionPlan; summary?: Message; controller: CommandController; labels: CommandBarLabels; format: (m: Message) => string; actionName: (id: string) => string;
  paramName: (id: string, param: string) => string; valueLabel: (id: string, param: string, value: string, fallback: string) => string;
  typed: string; setTyped: (t: string) => void; onEdit: (plan: ActionPlan, param: string, value: ArgumentValue | null) => void; onConfirm: (plan: ActionPlan) => void; onCancel: () => void;
}) {
  const { plan, labels, controller } = props;
  const actionId = plan.intent!.actionId;
  const definition = controller.definition(actionId);
  const [choices, setChoices] = useState<Record<string, ClarificationOption[]>>({});
  useEffect(() => {
    let live = true;
    void (async () => {
      const loaded: Record<string, ClarificationOption[]> = {};
      for (const spec of definition?.params ?? []) if (spec.type === "enum" || spec.type === "entity") loaded[spec.name] = await controller.options(plan, spec.name);
      if (live) setChoices(loaded);
    })();
    return () => { live = false; };
  }, [plan, definition, controller]);
  const shown = (definition?.params ?? []).filter((p) => p.required || plan.arguments[p.name]);
  const operations = plan.operations.filter((o) => o.op !== "read");
  const typedOk = plan.confirmation !== "typed" || (props.typed.normalize("NFKC").trim().toLowerCase() === (plan.confirmationPhrase ?? "").normalize("NFKC").trim().toLowerCase());
  return (
    <section className={`nlae-panel nlae-risk-${plan.risk}`} aria-label={props.actionName(actionId)}>
      <header className="nlae-head">
        <strong>{props.actionName(actionId)}</strong>
        <span className="nlae-badge">{labels[RISK_KEY[plan.risk]]}</span>
      </header>
      {props.summary && <p className="nlae-warning-text">{props.format(props.summary)}</p>}
      <dl className="nlae-args">
        {shown.map((spec) => (
          <div key={spec.name}>
            <dt>{props.paramName(actionId, spec.name)}</dt>
            <dd><Editor spec={spec} argument={plan.arguments[spec.name]} options={choices[spec.name]} labels={labels}
              label={(value, fallback) => props.valueLabel(actionId, spec.name, value, fallback)} onChange={(value) => props.onEdit(plan, spec.name, value)} /></dd>
          </div>
        ))}
      </dl>
      <Notes plan={plan} labels={labels} format={props.format} />
      {operations.length > 0 ? (
        <div className="nlae-changes">
          <p className="nlae-label">{fill(labels.changes, { count: operations.length })}</p>
          <ul>
            {operations.slice(0, PREVIEW_ROWS).map((o, i) => <li key={i}>{o.target.label}{o.after !== undefined ? <span className="nlae-muted"> → {describeChange(o.after, (v) => props.valueLabel(actionId, "category", v, v))}</span> : null}</li>)}
          </ul>
          {operations.length > PREVIEW_ROWS && <p className="nlae-muted">{fill(labels.moreChanges, { count: operations.length - PREVIEW_ROWS })}</p>}
        </div>
      ) : <p className="nlae-muted">{labels.noChanges}</p>}
      {plan.confirmation === "typed" && (
        <label className="nlae-typed">
          <span>{fill(labels.typeToConfirm, { phrase: `“${plan.confirmationPhrase}”` })}</span>
          <input type="text" autoComplete="off" value={props.typed} onChange={(e) => props.setTyped(e.target.value)} />
        </label>
      )}
      <div className="nlae-actions">
        <button type="button" className={plan.risk === "high" ? "nlae-button nlae-danger" : "nlae-button nlae-primary"} disabled={!typedOk} onClick={() => props.onConfirm(plan)}>{labels.confirm}</button>
        <button type="button" className="nlae-button" onClick={props.onCancel}>{labels.cancel}</button>
      </div>
    </section>
  );
}

function describeChange(after: unknown, label: (value: string) => string): string {
  if (after && typeof after === "object") {
    return Object.entries(after as Record<string, unknown>).map(([key, value]) => (key === "category" && typeof value === "string" ? label(value) : `${key}: ${String(value)}`)).join(", ");
  }
  return String(after);
}

function Editor({ spec, argument, options, labels, label, onChange }: {
  spec: ParamSpec; argument?: PlanArgument; options?: ClarificationOption[]; labels: CommandBarLabels;
  label: (value: string, fallback: string) => string; onChange: (value: ArgumentValue | null) => void;
}) {
  const value = argument?.value;
  const [draft, setDraft] = useState(typeof value === "string" || typeof value === "number" ? String(value) : "");
  useEffect(() => setDraft(typeof value === "string" || typeof value === "number" ? String(value) : ""), [value]);
  const commit = () => {
    if (draft === (typeof value === "string" || typeof value === "number" ? String(value) : "")) return;
    if (!draft.trim()) return onChange(spec.required ? draft : null);
    onChange(spec.type === "number" ? Number(draft) : draft);
  };
  if (spec.type === "enum" || spec.type === "entity") {
    const list = options ?? [];
    const current = typeof value === "string" ? value : "";
    return (
      <select value={current} onChange={(e) => onChange(e.target.value || null)}>
        {(!current || !spec.required) && <option value="">{labels.notSet}</option>}
        {current && !list.some((o) => o.value === current) && <option value={current}>{label(current, argument?.display ?? current)}</option>}
        {list.map((o) => <option key={o.value} value={o.value}>{label(o.value, o.label)}</option>)}
      </select>
    );
  }
  if (spec.type === "boolean") return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  if (spec.type === "dateRange") {
    const range = (value as DateRangeValue | undefined) ?? { start: null, end: null };
    const set = (part: "start" | "end", next: string) => {
      const updated = { ...range, [part]: next || null };
      onChange(updated.start || updated.end ? updated : null);
    };
    return (
      <span className="nlae-range">
        <label><span className="nlae-visually-hidden">{labels.from}</span><input type="date" value={range.start ?? ""} onChange={(e) => set("start", e.target.value)} /></label>
        <span aria-hidden="true">–</span>
        <label><span className="nlae-visually-hidden">{labels.to}</span><input type="date" value={range.end ?? ""} onChange={(e) => set("end", e.target.value)} /></label>
      </span>
    );
  }
  if (spec.type === "money") {
    const money = value as MoneyValue | undefined;
    const symbol = { eq: "=", gt: ">", gte: "≥", lt: "<", lte: "≤" }[money?.comparator ?? "eq"];
    return <span>{money ? `${symbol} ${(money.amountMinor / 100).toFixed(2)} ${money.currency ?? ""}`.trim() : labels.notSet}</span>;
  }
  return <input type={spec.type === "number" ? "number" : spec.type === "date" ? "date" : "text"} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />;
}
