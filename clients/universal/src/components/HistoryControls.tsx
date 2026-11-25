// Undo and Redo for the book in use: two buttons naming the edit, and the platform's shortcuts. A shortcut
// pressed while typing stays the text field's own undo.
import { useCallback, useEffect, useRef, useState } from "react";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import { HISTORY_CONFIRM, type HistoryDirection, type HistoryEntry, type HistoryState } from "../services/history/history";
import { ConfirmDelete } from "./common";

const EMPTY: HistoryState = { undo: null, redo: null };
const ICONS: Record<HistoryDirection, string> = { undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11", redo: "m15 14 5-5-5-5m5 5H9.5a5.5 5.5 0 0 0 0 11H13" };
/** Apple platforms use ⌘ and ⇧⌘Z, the others Ctrl and Ctrl+Y (Ctrl+Shift+Z works as well). */
const apple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
/** Fields with an undo of their own; a list, a checkbox or a button has none. */
const typing = (target: EventTarget | null) => target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)
  || (target instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|file|range|color)$/.test(target.type));

export function shortcutFor(event: KeyboardEvent, onApple = apple()): HistoryDirection | null {
  if (event.isComposing || event.altKey || (onApple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  return key === "y" && !onApple && !event.shiftKey ? "redo" : null;
}

export function HistoryControls() {
  const { m, t } = useI18n();
  const x = m.history;
  const { store, refresh } = useFinance();
  const [state, setState] = useState<HistoryState>(EMPTY);
  const [asking, setAsking] = useState<{ direction: HistoryDirection; entry: HistoryEntry } | null>(null);
  const [status, setStatus] = useState("");
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    // The book was switched: nothing of the other one stays on the buttons.
    setState(EMPTY);
    setAsking(null);
    setStatus("");
    const load = () => { store.history.state().then((next) => { if (live) setState(next); }).catch(() => { if (live) setState(EMPTY); }); };
    load();
    const stop = store.history.subscribe(load);
    return () => { live = false; stop(); };
  }, [store]);

  const name = useCallback((entry: HistoryEntry) => {
    const action = x.actions[entry.action] ?? entry.action;
    // A transfer is two entries with one text.
    if (entry.description && entry.entries <= 2) return t("history.one", { action, description: entry.description });
    return entry.entries > 1 ? t("history.many", { action, count: entry.entries }) : action;
  }, [x, t]);

  const perform = useCallback(async (direction: HistoryDirection, entry: HistoryEntry) => {
    if (busy.current) return;
    busy.current = true;
    setAsking(null);
    try {
      const outcome = await store.history.step(direction, entry.id);
      // Other pages read the book again even when nothing was written: what they show may be older than the conflict.
      await refresh();
      const edit = name(entry);
      setStatus(outcome === "done" ? t(direction === "undo" ? "history.undone" : "history.redone", { edit }) : outcome === "conflict" ? t("history.conflict", { edit }) : x.gone);
    } catch {
      setStatus(x.failed);
    } finally {
      busy.current = false;
    }
  }, [store, refresh, name, t, x]);

  const start = useCallback((direction: HistoryDirection) => {
    const entry = state[direction];
    if (!entry || busy.current) return;
    if (entry.entries >= HISTORY_CONFIRM) setAsking({ direction, entry });
    else void perform(direction, entry);
  }, [state, perform]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const direction = shortcutFor(event);
      // A question on screen is answered first; a text field keeps its own undo.
      if (!direction || event.defaultPrevented || event.repeat || typing(event.target) || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      start(direction);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start]);

  const mac = apple();
  const keys: Record<HistoryDirection, string> = mac ? { undo: "⌘Z", redo: "⇧⌘Z" } : { undo: "Ctrl+Z", redo: "Ctrl+Y" };
  const aria: Record<HistoryDirection, string> = mac ? { undo: "Meta+Z", redo: "Meta+Shift+Z" } : { undo: "Control+Z", redo: "Control+Y" };
  const button = (direction: HistoryDirection) => {
    const entry = state[direction];
    const label = entry ? t(direction === "undo" ? "history.undoTitle" : "history.redoTitle", { edit: name(entry) }) : direction === "undo" ? x.nothingUndo : x.nothingRedo;
    // Stays focusable when there is nothing to do, so keyboard focus is not lost after the last step.
    return (
      <button type="button" className="bw-history-button" aria-disabled={!entry} aria-label={label} title={`${label} (${keys[direction]})`} aria-keyshortcuts={aria[direction]} data-history={direction} onClick={() => start(direction)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[direction]} /></svg>
        <span>{direction === "undo" ? x.undo : x.redo}</span>
      </button>
    );
  };
  return (
    <div className="bw-history">
      <div className="bw-history-buttons" role="group" aria-label={x.label}>{button("undo")}{button("redo")}</div>
      <p className="bw-history-status" role="status" aria-live="polite">{status}</p>
      {asking && (
        <ConfirmDelete key={`${asking.direction}-${asking.entry.id}`} question={t(asking.direction === "undo" ? "history.confirmUndo" : "history.confirmRedo", { edit: name(asking.entry) })}
          action={asking.direction === "undo" ? x.undo : x.redo} onCancel={() => setAsking(null)} onConfirm={() => void perform(asking.direction, asking.entry)} />
      )}
    </div>
  );
}
