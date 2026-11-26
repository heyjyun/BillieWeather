// Category names in the interface language: a default is translated only while it keeps its default
// English name; renamed defaults and the person's own categories are shown as typed.
import { categoryLabel, MESSAGES, setCategoryKeys } from "../src/i18n";

afterEach(() => setCategoryKeys(null));

describe("categoryLabel", () => {
  it("translates defaults by their key's labels, the old built-ins and Uncategorized", () => {
    setCategoryKeys([{ name: "Groceries", key: "food.groceries" }, { name: "Food & dining", key: "food" }]);
    expect(categoryLabel(MESSAGES.es, "Groceries")).not.toBe("Groceries");
    expect(categoryLabel(MESSAGES["zh-CN"], "Food & dining")).toBe(MESSAGES["zh-CN"].categories["Food & dining"]);
    expect(categoryLabel(MESSAGES.ja, "Uncategorized")).toBe(MESSAGES.ja.categories.Uncategorized);
    expect(categoryLabel(MESSAGES.en, "Groceries")).toBe("Groceries");
  });

  it("shows renamed defaults and the person's own categories verbatim", () => {
    setCategoryKeys([{ name: "Supermarket", key: "food.groceries" }, { name: "Groceries", key: null }, { name: "Food", key: "food" }]);
    expect(categoryLabel(MESSAGES.es, "Supermarket")).toBe("Supermarket");
    expect(categoryLabel(MESSAGES.es, "Groceries")).toBe("Groceries"); // a custom category that happens to share the default name
    expect(categoryLabel(MESSAGES["zh-CN"], "Food")).toBe("Food");
  });
});
