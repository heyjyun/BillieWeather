import { icons } from "@billie/design-tokens";

/** A shared icon by name (packages/design-tokens icons); unknown names draw the generic file icon. */
export function ModuleIcon({ name, size = 20 }: { name: string; size?: number }) {
  const d = (icons as Record<string, string>)[name] ?? icons.file;
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}
