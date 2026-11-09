import { detectLocale, interpolate, LOCALES, MESSAGES } from "../src/i18n";
import importErrors from "../src/i18n/importErrors.json";

function leaves(node: unknown, path = ""): Array<[string, string]> {
  if (typeof node === "string") return [[path, node]];
  if (Array.isArray(node)) return node.map((value, i) => [`${path}[${i}]`, value]);
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => leaves(value, path ? `${path}.${key}` : key));
}
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  const english = new Map(leaves(MESSAGES.en));

  it.each(LOCALES.filter((l) => l !== "en"))("%s has every English key, nothing empty, and the same placeholders", (locale) => {
    const entries = leaves(MESSAGES[locale]);
    expect(entries.map(([key]) => key).sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of entries) {
      expect(text.trim(), `${locale} ${key}`).not.toBe("");
      expect(placeholders(text), `${locale} ${key}`).toEqual(placeholders(english.get(key)!));
    }
  });

  it("is actually translated (not just English copies)", () => {
    for (const locale of LOCALES.filter((l) => l !== "en")) expect(MESSAGES[locale].login.submit).not.toBe(MESSAGES.en.login.submit);
  });

  it("import errors come from Rails for every language and code", () => {
    const table = importErrors as Record<string, Record<string, string>>;
    const codes = Object.keys(table.en);
    expect(codes.length).toBe(62);
    for (const locale of LOCALES) {
      expect(Object.keys(table[locale]).sort()).toEqual([...codes].sort());
      for (const code of codes) expect(placeholders(table[locale][code]), `${locale} ${code}`).toEqual(placeholders(table.en[code]));
    }
  });

  it("detects the device language like the website does", () => {
    expect(detectLocale(["zh-Hant-HK"])).toBe("zh-TW");
    expect(detectLocale(["zh-TW"])).toBe("zh-TW");
    expect(detectLocale(["zh-Hans-CN"])).toBe("zh-CN");
    expect(detectLocale(["zh"])).toBe("zh-CN");
    expect(detectLocale(["ja-JP"])).toBe("ja");
    expect(detectLocale(["fr-FR", "es-MX"])).toBe("es");
    expect(detectLocale(["fr"])).toBe("en");
  });

  it("interpolates and leaves unknown placeholders alone", () => {
    expect(interpolate("{a} of {b} {c}", { a: 1, b: "x" })).toBe("1 of x {c}");
  });
});
