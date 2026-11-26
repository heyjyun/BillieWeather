// The default taxonomy and the category tree helpers (docs/architecture/category-hierarchy.md).
import {
  aiCategoryPaths, Categorizer, CategoryTree, categoryNameProblem, defaultCategories, defaultCategoryLabel, defaultCategoryName, flatDefaultCategories,
  inSubtree, kindForCategorized, LEGACY_CATEGORY_KEYS, matchAiCategory, parseAiProposals, regionalCategory, resolveDefaultKey, rollUp, rollUpGroup, type CategoryRow,
} from "../src";

const defaults = (): CategoryRow[] => flatDefaultCategories.map((category) => ({
  name: category.name, parent: category.parentKey ? defaultCategoryName(category.parentKey) : null, key: category.key, kind: category.kind,
  sortOrder: category.sortOrder, hidden: false, expanded: false,
}));
const custom = (name: string, parent: string | null, kind: CategoryRow["kind"] = "expense"): CategoryRow => ({ name, parent, key: null, kind, sortOrder: 99, hidden: false, expanded: false });

describe("default taxonomy", () => {
  it("has 14 roots and 70 subcategories with unique keys; the nine legacy built-ins keep their names", () => {
    expect(defaultCategories).toHaveLength(14);
    expect(flatDefaultCategories.filter((category) => category.parentKey)).toHaveLength(70);
    expect(new Set(flatDefaultCategories.map((category) => category.key)).size).toBe(84);
    expect(LEGACY_CATEGORY_KEYS.map(defaultCategoryName)).toEqual(["Income", "Housing", "Food & dining", "Transport", "Utilities", "Shopping", "Health", "Business", "Transfers"]);
    expect(defaultCategories.find((category) => category.key === "transfers")).toMatchObject({ kind: "transfer", deletable: false });
    expect(defaultCategoryLabel("food.groceries", "ja")).toBeTruthy();
    expect(defaultCategoryLabel("uncategorized", "es")).toBe("Sin categoría");
    expect(defaultCategoryLabel("food.groceries", "en")).toBeNull();
  });
});

describe("CategoryTree", () => {
  const tree = new CategoryTree([...defaults(), custom("Organic", "Groceries"), custom("Local", "Organic"), custom("Hidden one", "Groceries")].map((row) => (row.name === "Hidden one" ? { ...row, hidden: true } : row)));

  it("looks up names in any letter case and gives depth, ancestors, paths, kinds and subtrees", () => {
    expect(tree.get("organic")!.name).toBe("Organic");
    expect(tree.get("Local")).toMatchObject({ depth: 3, kind: "expense" });
    expect(tree.ancestors("Local")).toEqual(["Food & dining", "Groceries", "Organic"]);
    expect(tree.path("Local")).toBe("Food & dining › Groceries › Organic › Local");
    expect(tree.subtree("Groceries")).toEqual(["Groceries", "Hidden one", "Organic", "Local"]);
    expect(tree.isWithin("Local", "food & dining")).toBe(true);
    expect(tree.kindOf("Salary")).toBe("income");
    expect(tree.kindOf("Cash withdrawal")).toBe("transfer");
    expect(tree.kindOf("Uncategorized")).toBeNull();
    expect(tree.wouldCycle("Groceries", "Local")).toBe(true);
    expect(tree.wouldCycle("Local", "Groceries")).toBe(false);
  });

  it("leaves hidden categories out of pickers unless one is the current value", () => {
    expect(tree.flatten().some((node) => node.name === "Hidden one")).toBe(false);
    expect(tree.flatten({ keep: "Hidden one" }).some((node) => node.name === "Hidden one")).toBe(true);
    expect(tree.flatten({ includeHidden: true })).toHaveLength(87);
  });

  it("gives every descendant its root's kind and breaks loops in stored rows", () => {
    const odd = new CategoryTree([custom("A", "B", "income"), custom("B", "A", "expense"), custom("Child", "A", "expense")]);
    expect(odd.roots).toHaveLength(1);
    const root = odd.roots[0];
    expect(odd.subtree(root.name)).toHaveLength(3);
    expect(odd.flatten().every((node) => node.kind === root.kind)).toBe(true);
  });

  it("resolves keys to the current name, then the parent key's name, then Uncategorized", () => {
    const renamed = new CategoryTree(defaults().map((row) => (row.key === "food.groceries" ? { ...row, name: "Supermarket" } : row)));
    expect(renamed.resolveKey("food.groceries")).toBe("Supermarket");
    const deleted = new CategoryTree(defaults().filter((row) => row.key !== "food.groceries"));
    expect(deleted.resolveKey("food.groceries")).toBe("Food & dining");
    const none = new CategoryTree(defaults().filter((row) => !row.key!.startsWith("food")));
    expect(none.resolveKey("food.groceries")).toBe("Uncategorized");
    expect(resolveDefaultKey("transport.fuel")).toBe("Fuel");
  });
});

describe("roll-ups", () => {
  const tree = new CategoryTree([...defaults(), custom("Organic", "Groceries")]);
  const rows = [{ category: "Organic", n: 1 }, { category: "Groceries", n: 2 }, { category: "Food & dining", n: 3 }, { category: "Shopping", n: 4 }, { category: "Uncategorized", n: 5 }];

  it("group by root by default and drill into any node with “(direct)” for a node's own entries", () => {
    expect(rollUp(rows, tree).map((row) => row.category)).toEqual(["Food & dining", "Food & dining", "Food & dining", "Shopping", "Uncategorized"]);
    expect(rollUp(rows, tree, "Food & dining").map((row) => row.category)).toEqual(["Groceries", "Groceries", "Food & dining (direct)"]);
    expect(rollUp(rows, tree, "Groceries").map((row) => row.category)).toEqual(["Organic", "Groceries (direct)"]);
    expect(rollUpGroup(tree, "Organic", "Organic")).toEqual({ name: "Organic", direct: false });
    expect(inSubtree(rows, tree, "groceries").map((row) => row.n)).toEqual([1, 2]);
  });
});

describe("names", () => {
  it("only Uncategorized is reserved; names are unique ignoring case", () => {
    expect(categoryNameProblem("Shopping", [])).toBeNull();
    expect(categoryNameProblem("uncategorized", [])).toBe("reserved");
    expect(categoryNameProblem("groceries", ["Groceries"])).toBe("taken");
    expect(categoryNameProblem("groceries", ["Groceries"], "Groceries")).toBeNull();
  });
});

describe("keys in the rule-based categorizer", () => {
  it("emits the person's names for the default keys, and the default names without a tree (Ruby parity)", () => {
    expect(new Categorizer().categorize("WHOLE FOODS MARKET", -100)).toBe("Food & dining");
    const renamed = new CategoryTree(defaults().map((row) => (row.key === "food" ? { ...row, name: "Food" } : row.key === "income" ? { ...row, name: "Money in" } : row)));
    const categorizer = new Categorizer([], { tree: renamed });
    expect(categorizer.categorize("WHOLE FOODS MARKET", -100)).toBe("Food");
    expect(categorizer.categorize("PAYROLL ACME", 250000)).toBe("Money in");
    expect(categorizer.explain("WHOLE FOODS MARKET", -100)).toMatchObject({ key: "food", reason: "rule" });
    expect(regionalCategory("US", "ZELLE TO J SMITH", (key) => renamed.resolveKey(key))).toBe("Transfers");
  });

  it("decides an entry's kind from the category's tree when one is given", () => {
    const base = { amountMinor: 5000, accountType: null, description: "ZXQ" };
    expect(kindForCategorized({ ...base, category: "To savings", categoryKind: "transfer" })).toBe("transfer");
    expect(kindForCategorized({ ...base, category: "Odd jobs", categoryKind: "income" })).toBe("income");
    expect(kindForCategorized({ ...base, category: "Transfers", categoryKind: "expense" })).toBe("refund");
    expect(kindForCategorized({ ...base, category: "Transfers" })).toBe("transfer");
  });
});

describe("AI", () => {
  const tree = new CategoryTree([...defaults(), custom("Secret", null)].map((row) => (row.name === "Secret" ? { ...row, hidden: true } : row)));

  it("sends visible categories as full paths and matches answers by name or path", () => {
    const paths = aiCategoryPaths(tree);
    expect(paths).toContain("Food & dining › Groceries");
    expect(paths).not.toContain("Secret");
    expect(matchAiCategory(tree, "food & dining > groceries")).toBe("Groceries");
    expect(matchAiCategory(tree, "Groceries")).toBe("Groceries");
    expect(matchAiCategory(tree, "Shopping › Groceries")).toBeNull();
    expect(matchAiCategory(tree, "Uncategorized")).toBeNull();
  });

  it("keeps only usable proposals: known parent, new valid name, keys that were sent", () => {
    const raw = [
      { parent: "Pet food & supplies", name: "Grooming", keys: ["1", "9"] },
      { parent: "Nope", name: "X", keys: ["1"] },
      { parent: "Shopping", name: "groceries", keys: ["1"] },
      { parent: "Shopping", name: "Toys", keys: ["9"] },
      { parent: "Food & dining", name: "grooming", keys: ["2"] },
      "junk",
    ];
    expect(parseAiProposals(raw, tree, ["1", "2"])).toEqual([{ parent: "Pet food & supplies", name: "Grooming", keys: ["1", "2"] }]);
    expect(parseAiProposals(undefined, tree, ["1"])).toEqual([]);
  });
});
