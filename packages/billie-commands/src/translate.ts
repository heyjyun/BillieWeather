// Turns engine and host messages into the interface language, by message code. Shared by the
// universal client and the website so both show the same text for the same result.

import type { Message } from "@nlae/core";
import type { CommandMessages } from "./messages";

/** `{name}` placeholders filled from `vars`; unknown placeholders stay as they are. */
export function interpolate(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

/** Translates an engine or host message by code; unknown codes fall back to the English text. */
export function translateCommandMessage(c: CommandMessages, nav: Record<string, string>, actionName: (id: string) => string, message: Message & { param?: string }): string {
  const vars: Record<string, string | number> = { ...(message.vars ?? {}) };
  if (typeof vars.page === "string" && vars.page in nav) vars.page = nav[vars.page];
  if (typeof vars.action === "string") vars.action = actionName(vars.action);
  const param = (message.param ?? vars.param) as string | undefined;
  if (["missing_param", "choose_option", "choose_entity"].includes(message.code) && param && param in c.questions) return c.questions[param as keyof typeof c.questions];
  const messages = c.messages as Record<string, string>;
  if (message.code in messages) return interpolate(messages[message.code], vars);
  if (message.code.startsWith("invalid_")) return c.messages.invalid;
  return interpolate(message.message, vars);
}

/** Localized action name ("transactions.find" → c.actions.transactions_find). */
export const commandActionName = (c: CommandMessages) => (id: string): string => (c.actions as Record<string, string>)[id.replace(".", "_")] ?? id;
