// The nickname rules, mirrored from the server (app/models/user.rb User::NICKNAME_*, and
// services/identity-api/identity_api/validation.py). The server always re-checks; these exist so
// mistakes are caught before anything is sent. Pure functions: no network, storage or financial data.

export const NICKNAME_MAX = 40;

export type NicknameProblem = "blank" | "too_long" | "invalid";

// At least one letter, mark, number, punctuation or symbol, in any script. Whitespace and invisible
// format characters (e.g. a zero-width space) alone are not a nickname.
const VISIBLE = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u;
const CONTROL = /\p{Cc}/u;

/** Like Rails String#squish: trims and collapses runs of (Unicode) whitespace. */
export function squishNickname(value: string): string {
  return value.trim().split(/\s+/u).filter(Boolean).join(" ");
}

/** The nickname as the server will store it, or null when nothing visible is left. */
export function normalizeNickname(value: string | null | undefined): string | null {
  const squished = squishNickname(value ?? "");
  return VISIBLE.test(squished) ? squished : null;
}

/** Characters as the server counts them (code points), so an emoji counts once. */
const length = (value: string) => Array.from(value).length;

export function validateNickname(value: string | null | undefined): NicknameProblem | null {
  const nickname = normalizeNickname(value);
  if (nickname === null) return "blank";
  if (length(nickname) > NICKNAME_MAX) return "too_long";
  if (CONTROL.test(nickname)) return "invalid";
  return null;
}

/** The name to greet someone by, or null. Never an email address. */
export function preferredName(account: { nickname: string | null } | null | undefined): string | null {
  return normalizeNickname(account?.nickname);
}
