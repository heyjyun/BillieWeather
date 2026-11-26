// The default category taxonomy (schema/default-categories.json, docs/architecture/category-hierarchy.md):
// 14 roots and their subcategories, each with a stable `system_key` that never changes when a person
// renames or moves the category. New people start from it; existing people keep what they had and may
// add the missing defaults ("Add suggested categories"). Rails reads the same file.
import taxonomy from "../schema/default-categories.json";

export type CategoryKindName = "income" | "expense" | "transfer";
/** Interface languages other than English that carry labels for the defaults. */
export type TaxonomyLocale = "es" | "ja" | "ko" | "zh-CN" | "zh-TW";

export interface DefaultCategory {
  key: string;
  name: string;
  /** Null for a subcategory (it has its root's kind). */
  kind: CategoryKindName | null;
  labels: Partial<Record<TaxonomyLocale, string>>;
  /** One of the nine built-ins from before 2026-11 (kept with their original names). */
  legacy: boolean;
  deletable: boolean;
  children: DefaultCategory[];
}

/** One default as a flat row: parents come before their children. */
export interface FlatDefaultCategory {
  key: string;
  name: string;
  parentKey: string | null;
  kind: CategoryKindName;
  labels: Partial<Record<TaxonomyLocale, string>>;
  legacy: boolean;
  deletable: boolean;
  /** Position among its siblings, from 1. */
  sortOrder: number;
}

interface RawCategory {
  key: string;
  name: string;
  kind?: string;
  labels?: Record<string, string>;
  legacy?: boolean;
  deletable?: boolean;
  children?: RawCategory[];
}

const toDefault = (raw: RawCategory): DefaultCategory => ({
  key: raw.key, name: raw.name, kind: (raw.kind as CategoryKindName | undefined) ?? null, labels: raw.labels ?? {}, legacy: raw.legacy === true,
  deletable: raw.deletable !== false, children: (raw.children ?? []).map(toDefault),
});

/** The fixed placeholder for "not decided yet": never a stored category, never renamed, moved or deleted. */
export const UNCATEGORIZED = "Uncategorized" as const;
export const UNCATEGORIZED_LABELS: Partial<Record<TaxonomyLocale, string>> = taxonomy.uncategorized.labels;
export const TAXONOMY_VERSION: number = taxonomy.version;

/** The default tree (roots with their children), in the file's order. */
export const defaultCategories: readonly DefaultCategory[] = (taxonomy.categories as RawCategory[]).map(toDefault);

/** Every default, parents before children. */
export const flatDefaultCategories: readonly FlatDefaultCategory[] = defaultCategories.flatMap((root, rootIndex) => [
  { key: root.key, name: root.name, parentKey: null, kind: root.kind ?? "expense", labels: root.labels, legacy: root.legacy, deletable: root.deletable, sortOrder: rootIndex + 1 },
  ...root.children.map((child, index) => ({
    key: child.key, name: child.name, parentKey: root.key, kind: root.kind ?? "expense", labels: child.labels, legacy: child.legacy, deletable: child.deletable, sortOrder: index + 1,
  })),
]);

const BY_KEY = new Map(flatDefaultCategories.map((category) => [category.key, category]));
const BY_NAME = new Map(flatDefaultCategories.map((category) => [category.name.toLowerCase(), category]));

/** The nine built-ins from before 2026-11, in their old order (Income, Housing, …, Transfers). */
export const LEGACY_CATEGORY_KEYS = ["income", "housing", "food", "transport", "utilities", "shopping", "health", "business", "transfers"] as const;
export type LegacyCategoryKey = (typeof LEGACY_CATEGORY_KEYS)[number];

/** Keys code relies on. */
export const SYSTEM_KEYS = { income: "income", transfers: "transfers", business: "business" } as const;

export const defaultCategory = (key: string): FlatDefaultCategory | undefined => BY_KEY.get(key);
/** The English default name of a key, or null for an unknown key. */
export const defaultCategoryName = (key: string): string | null => BY_KEY.get(key)?.name ?? null;
/** The default whose English name this is (ignoring letter case), if any. */
export const defaultCategoryByName = (name: string): FlatDefaultCategory | undefined => BY_NAME.get(name.trim().toLowerCase());
/** `food.groceries` → `food`; a root key → null. */
export const parentKeyOf = (key: string): string | null => (key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : null);

/** The legacy key of an old built-in name ("Food & dining" → "food"), or null. */
export function legacyKeyForName(name: string): LegacyCategoryKey | null {
  const found = defaultCategoryByName(name);
  return found && (LEGACY_CATEGORY_KEYS as readonly string[]).includes(found.key) ? (found.key as LegacyCategoryKey) : null;
}

/**
 * A default category's label in an interface language, or null when there is none (English, an
 * unknown key). Uncategorized has labels too, under the key "uncategorized".
 */
export function defaultCategoryLabel(key: string, locale: string): string | null {
  if (key === "uncategorized") return UNCATEGORIZED_LABELS[locale as TaxonomyLocale] ?? null;
  return BY_KEY.get(key)?.labels[locale as TaxonomyLocale] ?? null;
}
