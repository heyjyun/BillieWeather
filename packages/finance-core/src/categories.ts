// Custom categories (app/models/finance/custom_category.rb) and the text "Categorize with AI"
// may send (Finance::AiCategorizer.clean_text). Keep both in step with Rails.
import { CATEGORIES, type BuiltInCategory, type Category } from "@billie/shared-types";

export const CATEGORY_NAME_MAX = 40;
export const CUSTOM_CATEGORY_MAX = 50;
/** Distinct merchants sent in one "Categorize with AI" request (Finance::AiCategorizer::MAX_ITEMS). */
export const AI_BATCH_MAX = 150;
const AI_TEXT_MAX = 80;

export const isBuiltInCategory = (name: string): name is BuiltInCategory => (CATEGORIES as readonly string[]).includes(name);

/** Collapses whitespace and drops control characters (Finance::CustomCategory.normalize_name). */
export function normalizeCategoryName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

export type CategoryNameProblem = "blank" | "too_long" | "reserved" | "taken";

/** Why a (normalized) name can't be used for a new or renamed custom category, or null. */
export function categoryNameProblem(name: string, existing: readonly string[], renaming?: string): CategoryNameProblem | null {
  if (!name) return "blank";
  if ([...name].length > CATEGORY_NAME_MAX) return "too_long";
  const lower = name.toLowerCase();
  if (CATEGORIES.some((builtIn) => builtIn.toLowerCase() === lower)) return "reserved";
  if (existing.some((other) => other.toLowerCase() === lower && other !== renaming)) return "taken";
  return null;
}

/** Built-in categories first (in their usual order), then the person's own. */
export function allCategories(custom: readonly string[]): Category[] {
  return [...CATEGORIES, ...custom.filter((name) => !isBuiltInCategory(name))];
}

/**
 * What "Categorize with AI" sends for one description: digit runs (card, reference, phone and
 * store numbers), email addresses and symbols removed, at most 80 characters. Null when no
 * merchant words are left. Same result as Finance::AiCategorizer.clean_text.
 */
export function cleanForAi(description: string): string | null {
  const text = description
    .replace(/\S*@\S+/gu, " ")
    .replace(/[#*]?[0-9][0-9\-/.:]*/gu, " ")
    .replace(/[^\p{L}\p{N}&'.\- ]/gu, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  const short = [...text].slice(0, AI_TEXT_MAX).join("").trim();
  return /\p{L}{2,}/u.test(short) ? short : null;
}

export interface AiGroup {
  key: string;
  text: string;
  direction: "in" | "out";
  ids: number[];
}

/**
 * Uncategorized transactions grouped by cleaned text (ignoring letter case) and direction, most
 * frequent first, with short keys ("1", "2", …). Rows without usable text are left out.
 */
export function aiGroups(transactions: ReadonlyArray<{ id: number; description: string; amountCents: number; category: Category }>): AiGroup[] {
  const groups = new Map<string, Omit<AiGroup, "key">>();
  for (const transaction of [...transactions].sort((a, b) => a.id - b.id)) {
    if (transaction.category !== "Uncategorized") continue;
    const text = cleanForAi(transaction.description);
    if (!text) continue;
    const direction = transaction.amountCents > 0 ? "in" : "out";
    const id = `${direction}:${text.toLowerCase()}`;
    const group = groups.get(id) ?? { text, direction, ids: [] };
    group.ids.push(transaction.id);
    groups.set(id, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.ids.length - a.ids.length || (a.text.toLowerCase() < b.text.toLowerCase() ? -1 : a.text.toLowerCase() > b.text.toLowerCase() ? 1 : 0) || (a.direction < b.direction ? -1 : 1))
    .map((group, index) => ({ key: String(index + 1), ...group }));
}
