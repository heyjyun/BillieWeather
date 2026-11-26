// Category names (app/models/finance/category.rb) and the text "Categorize with AI" may send
// (Finance::AiCategorizer.clean_text). Keep both in step with Rails. Categories form a tree of any depth
// (categoryTree.ts); the nine old built-ins are ordinary, editable categories now. Only Uncategorized is
// fixed: it is the placeholder for "not decided yet", never a stored category.
import { CATEGORIES, type BuiltInCategory, type Category } from "@billie/shared-types";
import type { CategoryTree } from "./categoryTree";
import { UNCATEGORIZED } from "./taxonomy";

export const CATEGORY_NAME_MAX = 40;
/** Categories per person, defaults included. */
export const CATEGORY_MAX = 500;
/** @deprecated The limit now counts every category (CATEGORY_MAX). */
export const CUSTOM_CATEGORY_MAX = CATEGORY_MAX;
/** Distinct merchants sent in one "Categorize with AI" request (Finance::AiCategorizer::MAX_ITEMS). */
export const AI_BATCH_MAX = 150;
const AI_TEXT_MAX = 80;

/**
 * True for the ten names that were built in before 2026-11 (Uncategorized included). Those are
 * ordinary categories now; this only matters for data from older sources (legacy rows, old servers).
 */
export const isBuiltInCategory = (name: string): name is BuiltInCategory => (CATEGORIES as readonly string[]).includes(name);

/** True for the fixed placeholder, in any letter case. */
export const isUncategorized = (name: string | null | undefined): boolean => (name ?? "").trim().toLowerCase() === UNCATEGORIZED.toLowerCase();

/** Collapses whitespace and drops control characters (Finance::CustomCategory.normalize_name). */
export function normalizeCategoryName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

/** "reserved": the name Uncategorized, which is never a category of its own. */
export type CategoryNameProblem = "blank" | "too_long" | "reserved" | "taken";

/** Why a (normalized) name can't be used for a new or renamed category, or null. Names are unique ignoring letter case. */
export function categoryNameProblem(name: string, existing: readonly string[], renaming?: string): CategoryNameProblem | null {
  if (!name) return "blank";
  if ([...name].length > CATEGORY_NAME_MAX) return "too_long";
  if (isUncategorized(name)) return "reserved";
  const lower = name.toLowerCase();
  if (existing.some((other) => other.toLowerCase() === lower && other !== renaming && other.toLowerCase() !== renaming?.toLowerCase())) return "taken";
  return null;
}

/** Every category name given (once each, in order), then Uncategorized. */
export function allCategories(names: readonly string[]): Category[] {
  const seen = new Set<string>();
  const out: Category[] = [];
  for (const name of names) {
    if (isUncategorized(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return [...out, UNCATEGORIZED];
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
    if (transaction.category !== UNCATEGORIZED) continue;
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

// ----------------------------------------------------------------------------- AI categories and proposals

/** What "Categorize with AI" sends as `categories`: every visible category as its full path, parents first. */
export function aiCategoryPaths(tree: CategoryTree): string[] {
  return tree.flatten().map((node) => tree.path(node.name));
}

/**
 * The category an AI answer names, matched by name or by full path (ignoring letter case and spacing
 * around the separator), or null. Uncategorized is never an answer worth applying.
 */
export function matchAiCategory(tree: CategoryTree, answer: string): string | null {
  const clean = normalizeCategoryName(answer);
  if (!clean || isUncategorized(clean)) return null;
  const direct = tree.canonical(clean);
  if (direct) return direct;
  const parts = clean.split(/\s*(?:›|>)\s*/u).filter(Boolean);
  if (parts.length < 2) return null;
  const last = tree.get(parts[parts.length - 1]);
  if (!last) return null;
  // The path given must be the category's real path, or its last part(s).
  const path = [...tree.ancestors(last.name), last.name].map((name) => name.toLowerCase());
  const given = parts.map((part) => part.toLowerCase());
  return given.length <= path.length && path.slice(-given.length).every((part, index) => part === given[index]) ? last.name : null;
}

/** A new subcategory the AI suggests: an existing parent, a new name and the merchant groups it fits. */
export interface AiProposal {
  parent: string;
  name: string;
  keys: string[];
}

/**
 * The usable proposals of an AI answer (older servers send none): the parent must exist (by name or
 * path) and not be hidden, the name must be a valid new name, and at least one key must be a group that
 * was sent. Duplicate names are merged. Nothing is created here; the person approves each one.
 */
export function parseAiProposals(raw: unknown, tree: CategoryTree, groupKeys: Iterable<string>): AiProposal[] {
  if (!Array.isArray(raw)) return [];
  const sent = new Set(groupKeys);
  const out = new Map<string, AiProposal>();
  for (const entry of raw) {
    const item = entry as { parent?: unknown; name?: unknown; keys?: unknown };
    if (typeof item.parent !== "string" || typeof item.name !== "string" || !Array.isArray(item.keys)) continue;
    const parent = matchAiCategory(tree, item.parent);
    const name = normalizeCategoryName(item.name);
    if (!parent || categoryNameProblem(name, tree.names()) !== null) continue;
    const keys = item.keys.filter((key): key is string => typeof key === "string" && sent.has(key));
    if (keys.length === 0) continue;
    const existing = out.get(name.toLowerCase());
    if (existing) existing.keys = [...new Set([...existing.keys, ...keys])];
    else out.set(name.toLowerCase(), { parent, name, keys: [...new Set(keys)] });
  }
  return [...out.values()];
}
