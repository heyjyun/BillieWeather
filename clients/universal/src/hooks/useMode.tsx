// Default Mode / Manual Mode (progressive disclosure). The mode is only a view preference: both modes
// read and write the same database through the same store, so switching never copies, changes or
// deletes a record. Every launch starts in Default Mode.
//
// Unfinished input survives a mode switch: forms keep their fields with `useDraftState`, which stores
// them here (in memory, for this session) instead of in the component, and restores them on return.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type Mode = "default" | "manual";

type Drafts = Map<string, Record<string, unknown>>;

interface ModeContextValue {
  mode: Mode;
  setMode: (mode: Mode) => void;
  drafts: { current: Drafts };
}

const ModeContext = createContext<ModeContextValue | null>(null);
// Components rendered on their own (tests, previews) behave as in Default Mode and keep no drafts.
const fallback: ModeContextValue = { mode: "default", setMode: () => undefined, drafts: { current: new Map() } };

export function ModeProvider({ children, initial = "default" }: { children: ReactNode; initial?: Mode }) {
  const [mode, setMode] = useState<Mode>(initial);
  const drafts = useRef<Drafts>(new Map());
  const value = useMemo(() => ({ mode, setMode, drafts }), [mode]);
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode() {
  const { mode, setMode, drafts } = useContext(ModeContext) ?? fallback;
  const manual = mode === "manual";
  const hasDraft = useCallback((key: string) => drafts.current.has(key), [drafts]);
  const clearDraft = useCallback((key: string) => { drafts.current.delete(key); }, [drafts]);
  return { mode, manual, setMode, hasDraft, clearDraft };
}

/** Like useState, but the value is kept as part of the draft `key` until `clearDraft(key)`. */
export function useDraftState<T>(key: string, field: string, initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
  const { drafts } = useContext(ModeContext) ?? fallback;
  const [value, setValue] = useState<T>(() => {
    const saved = drafts.current.get(key);
    if (saved && Object.prototype.hasOwnProperty.call(saved, field)) return saved[field] as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const set = useCallback((next: T | ((previous: T) => T)) => {
    setValue((previous) => {
      const resolved = typeof next === "function" ? (next as (p: T) => T)(previous) : next;
      drafts.current.set(key, { ...drafts.current.get(key), [field]: resolved });
      return resolved;
    });
  }, [drafts, key, field]);
  return [value, set];
}
