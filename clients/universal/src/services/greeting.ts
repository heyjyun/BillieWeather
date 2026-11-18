// Time-of-day and message selection for personalized greetings (the copy lives in
// src/i18n/personal.json, synced from config/locales/billie_personalization.*.yml).
// Same boundaries as the website (app/models/personalization.rb). Reads only the clock.

export type DayPart = "morning" | "afternoon" | "evening";

/** 05:00–11:59 morning, 12:00–17:59 afternoon, otherwise evening (late night included). */
export function dayPart(now: Date = new Date()): DayPart {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

/** A message that can include the nickname: the named form when there is one, otherwise the plain form. */
export interface NamedMessage { named: string; plain: string }

export function personalize(message: NamedMessage, name: string | null, vars: Record<string, string | number> = {}): string {
  const template = name ? message.named : message.plain;
  const values: Record<string, string | number> = { ...vars, ...(name ? { name } : {}) };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
