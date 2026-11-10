// Optional statement region as extra context for the rule-based categorizer. Synthetic data only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Categorizer, decimalToCents, normalizeRegion, regionalCategory, REGIONS_WITH_RULES, STATEMENT_REGIONS } from "../src";

const cases = JSON.parse(readFileSync(join(__dirname, "../fixtures/categorize-cases.json"), "utf8")) as Array<{ description: string; amount: string }>;

describe("statement region list", () => {
  it("accepts only known two-letter codes; anything else is Not specified", () => {
    expect(normalizeRegion("us")).toBe("US");
    expect(normalizeRegion(" GB ")).toBe("GB");
    for (const value of [null, undefined, "", "XX", "USA", "China", 1]) expect(normalizeRegion(value)).toBeNull();
    for (const code of ["US", "CN", "HK", "TW", "CA", "GB", "JP", "SG", "AU", "MX"]) expect(STATEMENT_REGIONS).toContain(code);
    expect(REGIONS_WITH_RULES.sort()).toEqual(["CN", "GB", "US"]);
  });
});

describe("categorizer with a region", () => {
  it("without a region (or one without rules), gives exactly the same results as before", () => {
    const results = (categorizer: Categorizer) => cases.map((c) => categorizer.categorize(c.description, decimalToCents(c.amount)));
    const reference = results(new Categorizer());
    expect(results(new Categorizer([], { region: null }))).toEqual(reference);
    expect(results(new Categorizer([], { region: "" }))).toEqual(reference);
    expect(results(new Categorizer([], { region: "JP" }))).toEqual(reference); // a region without rules changes nothing
  });

  it("never changes a category the existing rules already decide, whatever the region", () => {
    const base = new Categorizer();
    for (const region of STATEMENT_REGIONS) {
      const regional = new Categorizer([], { region });
      for (const c of cases) {
        const amount = decimalToCents(c.amount);
        const before = base.explain(c.description, amount);
        if (before.reason !== "none") expect(regional.explain(c.description, amount)).toEqual(before);
      }
    }
  });

  it.each([
    ["US", "ZELLE PAYMENT TO J SMITH 8812", "Transfers"],
    ["US", "VENMO *PAYMENT 1023", "Transfers"],
    ["US", "CHASE CREDIT CRD AUTOPAY", "Transfers"],
    ["US", "CHICK-FIL-A #01234 ATLANTA GA", "Food & dining"],
    ["US", "SUNOCO 0812345 PHILADELPHIA PA", "Transport"],
    ["US", "DUKE ENERGY BILL PAY", "Utilities"],
    ["CN", "支付宝-美团外卖订单", "Food & dining"],
    ["CN", "财付通-滴滴出行", "Transport"],
    ["CN", "微信支付 瑞幸咖啡", "Food & dining"],
    ["CN", "银联消费 京东商城", "Shopping"],
    ["CN", "微信转账 张三", "Transfers"],
    ["CN", "国家电网 电费", "Utilities"],
    ["CN", "ALIPAY TAOBAO.COM", "Shopping"],
    ["GB", "TESCO STORES 3021", "Food & dining"], // "store" alone would say Shopping, but "STORES" is not that word
    ["GB", "TFL TRAVEL CH", "Transport"],
    ["GB", "DIRECT DEBIT BRITISH GAS", "Utilities"],
    ["GB", "LAMBETH COUNCIL TAX DD", "Housing"],
    ["GB", "BOOTS 1123 LONDON", "Health"],
  ])("%s: recognizes %s", (region, description, category) => {
    expect(new Categorizer().categorize(description, -1234)).toBe("Uncategorized");
    expect(new Categorizer([], { region }).explain(description, -1234)).toEqual({ category, reason: "region" });
  });

  it("does not assume every transaction is from the chosen region", () => {
    // Another region's terms are not used: a UK statement does not read Chinese merchants, and vice versa.
    expect(new Categorizer([], { region: "GB" }).categorize("支付宝-美团外卖订单", -3000)).toBe("Uncategorized");
    expect(new Categorizer([], { region: "CN" }).categorize("TESCO STORES 3021", -3000)).toBe("Uncategorized");
    // Payment channels alone are not categories.
    for (const description of ["支付宝 消费", "UNIONPAY POS 88123", "ACH DEBIT 0000123", "FASTER PAYMENT REF 1234"]) {
      for (const region of REGIONS_WITH_RULES) expect(new Categorizer([], { region }).categorize(description, -1000)).toBe("Uncategorized");
    }
  });

  it("never touches money coming in (Income stays Income)", () => {
    expect(new Categorizer([], { region: "US" }).categorize("ZELLE FROM MOM", 5000)).toBe("Income");
    expect(new Categorizer([], { region: "CN" }).categorize("微信转账 收款", 5000)).toBe("Income");
  });

  it("keeps the deliberate AWS rule (Uncategorized) instead of a regional guess", () => {
    expect(new Categorizer([], { region: "US" }).explain("AWS EMEA ZELLE", -1000)).toEqual({ category: "Uncategorized", reason: "rule" });
  });

  it("lets a person's remembered rule win over the region", () => {
    const categorizer = new Categorizer([{ merchantKey: "zelle to", income: false, category: "Housing" }], { region: "US" });
    expect(categorizer.explain("ZELLE TO J SMITH", -150000)).toEqual({ category: "Housing", reason: "learned" });
    expect(regionalCategory("US", "ZELLE TO J SMITH")).toBe("Transfers");
  });
});
