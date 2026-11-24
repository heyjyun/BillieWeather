import { parseQuickEntry } from "../src/services/quickEntry";

it("reads explicit English and Chinese amounts without inferring a currency", () => {
  expect(parseQuickEntry("Spent 12.34 on Synthetic lunch")).toEqual({ kind: "expense", amount: "12.34", description: "Synthetic lunch" });
  expect(parseQuickEntry("收入 125,50 合成工资")).toEqual({ kind: "income", amount: "125.50", description: "合成工资" });
  for (const phrase of ["Lunch", "Spent $15 groceries", "spent 0 food", "spent -10 food", "sent 100 to someone", "spent 1.234 food"]) {
    expect(parseQuickEntry(phrase)).toBeNull();
  }
});
