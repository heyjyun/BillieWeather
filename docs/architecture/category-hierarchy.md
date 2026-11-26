# Category hierarchy (2026-11)

Categories form a tree of unlimited depth that each person owns and edits completely.
New people start from a default taxonomy (14 roots, 70 subcategories:
`packages/finance-core/schema/default-categories.json`). Existing people keep exactly
what they had.

## Identity

- **A category is identified by its name.** Names are unique per person ignoring letter
  case, at every depth (two "Other" subcategories are not allowed). Transactions, merchant
  rules, budgets, receipts and the sync format keep storing the name as text. Renaming
  rewrites those rows in one database transaction (as before).
- **Defaults carry a stable `system_key`** (`food`, `food.groceries`, `transfers`, …) that
  never changes when the person renames or moves them. Code that once compared against a
  built-in name (`"Food & dining"`, `"Transfers"`, `"Income"`, `"Business"`) resolves the
  key to the person's current name instead. If the person deleted that category, the key
  resolves to nothing, and callers fall back to its parent key (`food.groceries` → `food`)
  and then to Uncategorized.
- **Uncategorized is not a category.** It is the fixed placeholder for "not decided yet":
  never stored as a row, never renamed, moved or deleted, and never anyone's parent. The
  text `"Uncategorized"` stays the stored value.
- **Transfers** (`system_key: "transfers"`) can be renamed, reordered among the roots and
  given subcategories. It cannot be deleted, merged away or nested under another category.
  Its subtree is kind `transfer`: choosing any category inside it makes the entry a transfer.

## Tree rules

- `kind` (`income` | `expense` | `transfer`) belongs to the root. Every descendant has its
  root's kind. Moving a subtree under a root of another kind changes the subtree's kind.
  Only `income` and `expense` roots may be created by people.
- Depth is unlimited. A move that would make a category its own ancestor is rejected
  (`category_cycle`).
- Sort order is among siblings.
- **Delete** at any depth: the category's entries move to a chosen destination (default:
  its parent, or Uncategorized for a root). Its remembered rules move there too, or are
  forgotten when the destination is Uncategorized. Its children move up to its parent,
  keeping their order. Budgets on it move to the destination if the destination has no
  budget for the same period; otherwise they are removed.
- **Merge** A into B: like delete with destination B. A's children become B's children.
  Merging into a descendant of A is rejected (`category_cycle`).
- Limits: 500 categories per person (defaults included), names 1–40 characters after
  `normalizeCategoryName`.
- `hidden` removes a category (and its subtree) from pickers. Existing entries keep it.

## Roll-ups (selectors, budgets, reports)

A category always means **itself plus all its descendants**:

- A transaction filter or selector on X matches entries in X's subtree.
- A budget on X counts spending in X's subtree.
- Reports group by root by default and can drill into any node. A node's total is its own
  entries plus its descendants'. The node's own entries appear as "X (direct)" when it also
  has children.

## AI and learned rules

- Learned (merchant) rules may point at any category at any depth.
- "Categorize with AI" sends each category as a full path (`Food & dining › Groceries`) and
  asks for the most specific fitting category. Answers are matched by name or by path.
- The AI may also propose **new subcategories** (`{parent, name, keys}`: an existing parent
  name, a new name, and the merchant groups it fits). Proposals are never created
  automatically. They are shown to the person, who can approve, rename or dismiss each
  one. Approving creates the subcategory and files the proposal's groups under it, as one
  undoable batch.

## Expansion (collapsed by default)

Category trees show roots with their descendants collapsed. Each category row stores
`expanded` (default false). Expanding or collapsing a node saves it: on the website in
`finance_categories.expanded`, in the apps in the local `categories.expanded`. The preference
is per person and per database; it is not part of what web sync overwrites.

## Storage

Rails (`finance_categories`, replacing reads of `finance_custom_categories` and
`finance_category_settings`, which are kept unchanged for rollback and dropped later):

| column       | notes                                                  |
|--------------|--------------------------------------------------------|
| user_id      | owner                                                  |
| name         | ≤ 40, unique per user on `lower(name)`                 |
| parent_id    | self-reference (same user), null for roots, on delete restrict |
| system_key   | default's key or null; unique per user when present    |
| category_kind| income / expense / transfer                            |
| sort_order   | among siblings                                         |
| hidden, expanded | booleans, default false                            |

`users.finance_categories_seeded_at` records that a person's tree was created. A person
without it gets the default taxonomy the first time their categories are read. The
migration sets it for every existing user after materializing their old structure:
the nine old built-ins (with their legacy keys), their custom categories, and their old
parent, kind, order and hidden settings. Nothing is added from the new taxonomy.

The apps (local SQLite, migration `0011_category_hierarchy.sql`) get the same shape in a
`categories` table keyed by name (`parent` holds the parent's name). The migration copies
`custom_categories` and `category_meta`, and adds the nine legacy built-ins when the database
already holds any transactions, categories, rules or budgets. A database with none of
those is seeded with the defaults the first time it opens (the `category_seed` setting
records which happened).

**Add suggested categories** (website and apps) adds the defaults a person doesn't have
yet, matched by `system_key` first and then by name ignoring case. It never renames,
moves or duplicates anything. A suggested child whose parent is missing is added under
the existing category with the parent's key or name, or else the parent is added too.

## Sync (wire format)

`GET /api/client/v1/finance/categories` returns

```json
{
  "categories": ["Groceries", "…"],
  "tree": [{"name": "Food & dining", "parent": null, "kind": "expense", "key": "food", "sort_order": 3, "hidden": false}]
}
```

`categories` keeps its old meaning for older apps: every name except the ten legacy
built-in names. `tree` lists every category, parents before children. Newer apps apply
`tree` additively: they create missing categories under their parent (creating missing
parents first) and adopt the website's parent, kind, order and hidden for categories with
the same name. They never delete local categories and never touch `expanded`.

Statement upload (`POST …/statements`) may include `categories: [{name, parent, kind}]`
(parents before children). The server creates the missing ones with that parent. Rows
whose category is still unknown are added as roots, as before.

AI (`POST …/categorize`) accepts `categories` as names or paths. It returns
`{assignments: [{key, category}], proposals: [{parent, name, keys}]}`. Older apps ignore
`proposals`.
