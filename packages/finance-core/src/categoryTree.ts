// A person's category tree (docs/architecture/category-hierarchy.md): names are the identity (unique
// ignoring letter case, at any depth), `parent` holds the parent's name, depth is unlimited, the kind
// belongs to the root, and a category always means itself plus all its descendants. Pure functions
// over rows as stored (the apps' `categories` table, Rails' finance_categories, the sync `tree`).
import { defaultCategoryName, parentKeyOf, UNCATEGORIZED, type CategoryKindName } from "./taxonomy";

export interface CategoryRow {
  name: string;
  parent: string | null;
  /** The default's stable key, or null for a category the person made. */
  key: string | null;
  kind: CategoryKindName;
  sortOrder: number;
  hidden: boolean;
  expanded: boolean;
}

export interface CategoryNode extends CategoryRow {
  /** 0 for a root. */
  depth: number;
  children: CategoryNode[];
}

/** Separator of a category path ("Food & dining › Groceries"). */
export const PATH_SEPARATOR = " › ";
/** Suffix of a node's own entries in a drill-down when it also has children ("Food & dining (direct)"). */
export const DIRECT_SUFFIX = " (direct)";

const lower = (name: string) => name.toLowerCase();
const byOrder = (a: CategoryNode, b: CategoryNode) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

export class CategoryTree {
  readonly roots: CategoryNode[];
  private nodes = new Map<string, CategoryNode>();
  private byKey = new Map<string, CategoryNode>();

  constructor(rows: readonly CategoryRow[]) {
    for (const row of rows) {
      if (!row.name || lower(row.name) === lower(UNCATEGORIZED) || this.nodes.has(lower(row.name))) continue;
      const node: CategoryNode = { ...row, depth: 0, children: [] };
      this.nodes.set(lower(row.name), node);
      if (row.key && !this.byKey.has(row.key)) this.byKey.set(row.key, node);
    }
    this.roots = [];
    for (const node of this.nodes.values()) {
      const parent = node.parent ? this.nodes.get(lower(node.parent)) : undefined;
      // A parent that is missing, or that would close a loop, makes the category a root.
      if (parent && parent !== node && !this.reaches(parent, node)) {
        node.parent = parent.name;
        parent.children.push(node);
      } else {
        node.parent = null;
        this.roots.push(node);
      }
    }
    const settle = (node: CategoryNode, depth: number, kind: CategoryKindName) => {
      node.depth = depth;
      node.kind = kind; // every descendant has its root's kind
      node.children.sort(byOrder);
      for (const child of node.children) settle(child, depth + 1, kind);
    };
    this.roots.sort(byOrder);
    for (const root of this.roots) settle(root, 0, root.kind);
  }

  /** True when walking up from `from` (through raw parent names) meets `target`. */
  private reaches(from: CategoryNode, target: CategoryNode): boolean {
    const seen = new Set<CategoryNode>();
    for (let current: CategoryNode | undefined = from; current; current = current.parent ? this.nodes.get(lower(current.parent)) : undefined) {
      if (current === target) return true;
      if (seen.has(current)) return false;
      seen.add(current);
    }
    return false;
  }

  get size(): number {
    return this.nodes.size;
  }

  /** The category with this name (any letter case). */
  get(name: string | null | undefined): CategoryNode | undefined {
    return name ? this.nodes.get(lower(name.trim())) : undefined;
  }

  has(name: string | null | undefined): boolean {
    return this.get(name) !== undefined;
  }

  /** The stored spelling of a name, or null when there is no such category. */
  canonical(name: string | null | undefined): string | null {
    return this.get(name)?.name ?? null;
  }

  /** Every category, depth-first in display order (parents before children). */
  flatten(options: { includeHidden?: boolean; keep?: string | null } = {}): CategoryNode[] {
    const out: CategoryNode[] = [];
    const keep = options.keep ? lower(options.keep) : null;
    const walk = (nodes: CategoryNode[], hiddenAbove: boolean) => {
      for (const node of nodes) {
        // Hidden categories (and everything below them) are left out, except the current value.
        const hidden = hiddenAbove || node.hidden;
        if (!hidden || options.includeHidden || lower(node.name) === keep) out.push(node);
        walk(node.children, hidden);
      }
    };
    walk(this.roots, false);
    return out;
  }

  /** Every name in display order. */
  names(): string[] {
    return this.flatten({ includeHidden: true }).map((node) => node.name);
  }

  /** The category and all its descendants (names), or [] for an unknown name. */
  subtree(name: string): string[] {
    const node = this.get(name);
    if (!node) return [];
    const out: string[] = [];
    const walk = (current: CategoryNode) => {
      out.push(current.name);
      current.children.forEach(walk);
    };
    walk(node);
    return out;
  }

  /** Lower-case names of the subtree, for matching. */
  subtreeSet(name: string): Set<string> {
    return new Set(this.subtree(name).map(lower));
  }

  /** True when `name` is `ancestor` or lies below it. */
  isWithin(name: string | null | undefined, ancestor: string | null | undefined): boolean {
    if (!name || !ancestor) return false;
    for (let node = this.get(name); node; node = node.parent ? this.get(node.parent) : undefined) {
      if (lower(node.name) === lower(ancestor)) return true;
    }
    return false;
  }

  /** Parents from the root down to (not including) the category. */
  ancestors(name: string): string[] {
    const out: string[] = [];
    for (let node = this.get(name); node?.parent; node = this.get(node.parent)) out.unshift(node.parent);
    return out;
  }

  /** "Food & dining › Groceries"; the name itself for a root or an unknown name. */
  path(name: string, label: (name: string) => string = (value) => value): string {
    const node = this.get(name);
    if (!node) return label(name);
    return [...this.ancestors(node.name), node.name].map(label).join(PATH_SEPARATOR);
  }

  /** The root a category belongs to (itself for a root). */
  rootOf(name: string): CategoryNode | undefined {
    let node = this.get(name);
    while (node?.parent) node = this.get(node.parent);
    return node;
  }

  /** The category's kind (its root's), or null for Uncategorized and unknown names. */
  kindOf(name: string | null | undefined): CategoryKindName | null {
    return this.get(name)?.kind ?? null;
  }

  /** True when giving `name` the parent `parent` would make it its own ancestor (category_cycle). */
  wouldCycle(name: string, parent: string | null): boolean {
    return parent !== null && this.isWithin(parent, name);
  }

  /** The category holding a default's key, if the person still has it. */
  byKeyNode(key: string): CategoryNode | undefined {
    return this.byKey.get(key);
  }

  /** The person's current name for a key, or null when that category was deleted. */
  nameForKey(key: string): string | null {
    return this.byKey.get(key)?.name ?? null;
  }

  /** Key → current name, else the parent key's name (`food.groceries` → `food`), else Uncategorized. */
  resolveKey(key: string | null | undefined): string {
    for (let current = key ?? null; current; current = parentKeyOf(current)) {
      const name = this.nameForKey(current);
      if (name) return name;
    }
    return UNCATEGORIZED;
  }

  /** Names of every category of this kind. */
  namesOfKind(kind: CategoryKindName): Set<string> {
    return new Set(this.flatten({ includeHidden: true }).filter((node) => node.kind === kind).map((node) => node.name));
  }

  /** The child of `ancestor` on the way down to `name` (null when `name` is `ancestor` itself or not below it). */
  childToward(name: string, ancestor: string): CategoryNode | null {
    const node = this.get(name);
    if (!node || !this.isWithin(name, ancestor) || lower(node.name) === lower(ancestor)) return null;
    let current: CategoryNode | undefined = node;
    while (current?.parent && lower(current.parent) !== lower(ancestor)) current = this.get(current.parent);
    return current ?? null;
  }
}

/** Resolves a key against the defaults only (callers without a person's tree, and Ruby fixture parity). */
export function resolveDefaultKey(key: string | null | undefined): string {
  for (let current = key ?? null; current; current = parentKeyOf(current)) {
    const name = defaultCategoryName(current);
    if (name) return name;
  }
  return UNCATEGORIZED;
}

// ------------------------------------------------------------------------------------------- roll-ups

/** Where one entry's category lands in a report grouped at some level of the tree. */
export interface RollUpGroup {
  /** The category the amount is shown under (a root, or a child of the focused node). */
  name: string;
  /** The focused node's own entries, shown as "X (direct)" when it also has children. */
  direct: boolean;
}

/**
 * The group an entry's category belongs to. Without `focus`: its root (Uncategorized and unknown names
 * stay as they are). With `focus` X: the child of X it lies under, or X itself (direct) for X's own
 * entries; null when the category is outside X's subtree.
 */
export function rollUpGroup(tree: CategoryTree, category: string, focus: string | null = null): RollUpGroup | null {
  if (!focus) {
    const root = tree.rootOf(category);
    return { name: root?.name ?? category, direct: false };
  }
  const focused = tree.get(focus);
  if (!focused || !tree.isWithin(category, focused.name)) return null;
  const child = tree.childToward(category, focused.name);
  if (child) return { name: child.name, direct: false };
  return { name: focused.name, direct: focused.children.length > 0 };
}

/** The label of a group: "X (direct)" for a node's own entries next to its children. */
export const rollUpName = (group: RollUpGroup): string => (group.direct ? `${group.name}${DIRECT_SUFFIX}` : group.name);

/**
 * The same rows with `category` replaced by its group (see rollUpGroup), for charts and tables that
 * group by category. With `focus`, rows outside the focused subtree are left out.
 */
export function rollUp<T extends { category: string }>(rows: readonly T[], tree: CategoryTree, focus: string | null = null): T[] {
  return rows.flatMap((row) => {
    const group = rollUpGroup(tree, row.category, focus);
    return group ? [{ ...row, category: rollUpName(group) }] : [];
  });
}

/** Rows whose category is `category` or lies below it (a filter or selector on a category). */
export function inSubtree<T extends { category: string }>(rows: readonly T[], tree: CategoryTree, category: string): T[] {
  const names = tree.has(category) ? tree.subtreeSet(category) : new Set([lower(category)]);
  return rows.filter((row) => names.has(lower(row.category)));
}

/** Matcher for one category's subtree (Uncategorized and unknown names match only themselves). */
export function subtreeMatcher(tree: CategoryTree | null | undefined, category: string): (name: string) => boolean {
  const names = tree?.has(category) ? tree.subtreeSet(category) : new Set([lower(category)]);
  return (name) => names.has(lower(name));
}
