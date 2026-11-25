// Keyboard and screen-reader focus when a screen changes under the person: the control they pressed is
// gone (or was disabled while working), which leaves focus nowhere. These only ever act then.
import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

export const focusIsLost = () => !document.activeElement || document.activeElement === document.body;

/** Moves focus to the returned ref's element whenever `key` changes and focus is nowhere. */
export function useFocusWhenLost<T extends HTMLElement>(key: unknown = null): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (focusIsLost()) ref.current?.focus({ preventScroll: true });
  }, [key]);
  return ref;
}

/**
 * A panel the person just opened: focus moves into it (`pick` chooses where), and back to the control
 * that opened it (or the page heading) when it closes. Opening from the navigation keeps focus there.
 */
export function useOpenedPanel<T extends HTMLElement>(pick: (panel: T) => HTMLElement | null = (panel) => panel): RefObject<T | null> {
  const ref = useRef<T>(null);
  const choose = useRef(pick);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = ref.current;
    if (panel && !opener?.closest("nav") && !panel.contains(opener)) choose.current(panel)?.focus();
    return () => {
      setTimeout(() => {
        if (typeof document === "undefined" || !focusIsLost()) return;
        const target = opener?.isConnected && opener !== document.body && !opener.matches(":disabled") ? opener : document.querySelector<HTMLElement>("main h1");
        target?.focus({ preventScroll: true });
      });
    };
  }, []);
  return ref;
}

/** Arrow keys move between the `role="radio"` buttons of a group, as in a native radio group. */
export function radioGroupKeys(event: KeyboardEvent<HTMLElement>) {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const at = radios.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length];
  next.focus();
  next.click();
}
