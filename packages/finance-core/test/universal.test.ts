// Universal import pipeline. Synthetic data only.
import { deflateRawSync } from "node:zlib";
import {
  Categorizer, commitPlan, createDraft, decimalToMinor, detectDateOrder, detectDecimalSeparator, detectDelimiter, detectEncoding, headerFingerprint,
  ImportPipelineError, layoutToTable, matchTemplate, parseAmount, parseDate, reviseDraft, spreadsheetNumberToMinor, statementHashes, suggestedDecision,
  templateFrom, toStorageCents, createOcrDraft, parseOcrResult, type ImportContext, type ImportDraft, type OcrEngine, type OcrPage, type OcrResult,
} from "../src";

const enc = (text: string) => new TextEncoder().encode(text);

function context(overrides: Partial<ImportContext> = {}): ImportContext {
  return {
    categorizer: new Categorizer([]), customCategories: [], templates: [], existing: [], existingFileHashes: new Set(), deviceCurrency: null,
    storableCurrencies: ["USD", "CAD", "EUR", "GBP", "AUD", "NZD", "SGD", "HKD", "CNY", "JPY"], today: "2026-12-31", ocr: null, ...overrides,
  };
}

const amounts = (draft: ImportDraft) => draft.rows.map((row) => row.amountMinor);
const dates = (draft: ImportDraft) => draft.rows.map((row) => row.transactionDate);
const codes = (draft: ImportDraft, index: number) => draft.rows[index].issues.map((item) => item.code);

describe("exact money", () => {
  it("converts decimals to minor units by ISO 4217 precision, never via floats", () => {
    expect(decimalToMinor("1234.56", 2)).toEqual({ ok: true, minor: 123456 });
    expect(decimalToMinor("0.1", 2)).toEqual({ ok: true, minor: 10 });
    expect(decimalToMinor("1000", 0)).toEqual({ ok: true, minor: 1000 });
    expect(decimalToMinor("1000.50", 0)).toEqual({ ok: false, problem: "precision" });
    expect(decimalToMinor("12.345", 3)).toEqual({ ok: true, minor: 12345 });
    expect(decimalToMinor("12.340", 2)).toEqual({ ok: true, minor: 1234 });
    expect(decimalToMinor("9999999999999999999", 2)).toEqual({ ok: false, problem: "too_large" });
    expect(toStorageCents(1000, 0)).toBe(100000); // JPY 1000 -> legacy scale-2 storage
    expect(toStorageCents(12345, 3)).toBeNull(); // KWD 12.345 cannot be stored at scale 2
    expect(toStorageCents(12340, 3)).toBe(1234);
  });

  it("rounds spreadsheet float noise only when it is clearly noise", () => {
    expect(spreadsheetNumberToMinor("0.30000000000000004", 2)).toEqual({ ok: true, minor: 30, rounded: true });
    expect(spreadsheetNumberToMinor("1234.5599999999999", 2)).toEqual({ ok: true, minor: 123456, rounded: true });
    expect(spreadsheetNumberToMinor("12.345", 2)).toEqual({ ok: false, problem: "precision" });
  });

  it("parses the amount formats banks print", () => {
    const value = (raw: string, decimal: "." | "," = ".", exponent = 2) => {
      const parsed = parseAmount(raw, decimal, exponent);
      return parsed.ok ? parsed.value.minor : parsed.problem;
    };
    expect(value("1,234.56")).toBe(123456);
    expect(value("1.234,56", ",")).toBe(123456);
    expect(value("1 234,56", ",")).toBe(123456);
    expect(value("1 234,56 €", ",")).toBe(123456);
    expect(value("1'234.56")).toBe(123456);
    expect(value("1,23,456.00")).toBe(12345600);
    expect(value("(12.30)")).toBe(-1230);
    expect(value("12.30-")).toBe(-1230);
    expect(value("−12.30")).toBe(-1230);
    expect(value("12.30 DR")).toBe(-1230);
    expect(value("12.30 CR")).toBe(1230);
    expect(value("-12.30 CR")).toBe("unreadable");
    expect(value("US$1,000.00")).toBe(100000);
    expect(value("¥1,000", ".", 0)).toBe(1000);
    expect(value("１２３．４５")).toBe(12345);
    expect(value("12,3,4")).toBe("unreadable");
    expect(value("")).toBe("empty");
    expect(parseAmount("€ 12,30", ",", 2)).toMatchObject({ ok: true, value: { currencyHint: "€" } });
  });

  it("detects the decimal separator only from evidence", () => {
    expect(detectDecimalSeparator(["1.234,56", "12,00"], 2)).toMatchObject({ decimal: ",", ambiguous: false });
    expect(detectDecimalSeparator(["1,234.56", "-5.75"], 2)).toMatchObject({ decimal: "." });
    expect(detectDecimalSeparator(["1,234", "5,678"], 2)).toMatchObject({ decimal: null, ambiguous: true });
    expect(detectDecimalSeparator(["1,234", "5,678"], 0)).toMatchObject({ decimal: ".", ambiguous: false }); // JPY: grouping
    expect(detectDecimalSeparator(["1.234,56", "1,234.56"], 2)).toMatchObject({ conflict: true });
  });
});

describe("dates", () => {
  it("parses unambiguous formats and refuses to guess day/month order", () => {
    expect(parseDate("2026-03-04", null)).toEqual({ ok: true, iso: "2026-03-04" });
    expect(parseDate("2026年3月4日", null)).toEqual({ ok: true, iso: "2026-03-04" });
    expect(parseDate("2026년 3월 4일", null)).toEqual({ ok: true, iso: "2026-03-04" });
    expect(parseDate("04 Mar 2026", null)).toEqual({ ok: true, iso: "2026-03-04" });
    expect(parseDate("4. März 2026", null)).toEqual({ ok: true, iso: "2026-03-04" });
    expect(parseDate("20260304", null)).toEqual({ ok: true, iso: "2026-03-04" });
    expect(parseDate("2026-03-04T10:15:00Z", null)).toEqual({ ok: true, iso: "2026-03-04" });
    expect(parseDate("03/04/2026", null)).toEqual({ ok: false, problem: "ambiguous" });
    expect(parseDate("03/04/2026", "dmy")).toEqual({ ok: true, iso: "2026-04-03" });
    expect(parseDate("03/04/2026", "mdy")).toEqual({ ok: true, iso: "2026-03-04" });
    expect(parseDate("31/02/2026", "dmy")).toEqual({ ok: false, problem: "invalid" });
  });

  it("detects the order from the column", () => {
    expect(detectDateOrder(["03/04/2026", "25/04/2026"])).toMatchObject({ order: "dmy", ambiguous: false });
    expect(detectDateOrder(["03/04/2026", "04/25/2026"])).toMatchObject({ order: "mdy" });
    expect(detectDateOrder(["03/04/2026", "04/05/2026"])).toMatchObject({ order: null, ambiguous: true });
    expect(detectDateOrder(["25/04/2026", "04/25/2026"])).toMatchObject({ conflict: true });
    expect(detectDateOrder(["01/01/2026"])).toMatchObject({ ambiguous: false });
  });
});

describe("detection", () => {
  it("detects encodings: UTF-8, BOMs, and legacy encodings needing confirmation", () => {
    expect(detectEncoding(enc("日期,金额"))?.detection).toEqual({ encoding: "utf-8", confident: true, alternatives: [] });
    const utf16 = new Uint8Array([0xff, 0xfe, ...[..."Date"].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(detectEncoding(utf16)).toMatchObject({ text: "Date", detection: { encoding: "utf-16le", confident: true } });
    // "交易日期" in GB18030
    const gbk = new Uint8Array([0xbd, 0xbb, 0xd2, 0xd7, 0xc8, 0xd5, 0xc6, 0xda]);
    const detected = detectEncoding(gbk)!;
    // Legacy CJK encodings cannot be told apart reliably: never confident, the person picks.
    expect(detected.detection.confident).toBe(false);
    expect([detected.detection.encoding, ...detected.detection.alternatives]).toContain("gb18030");
    expect(new TextDecoder("gb18030").decode(gbk)).toBe("交易日期");
    expect(detectEncoding(new Uint8Array([0x41, 0x00, 0x42]))).toBeNull(); // binary
  });

  it("detects delimiters", () => {
    expect(detectDelimiter("a;b;c\n1;2,5;3\n4;5,5;6")).toEqual({ delimiter: ";", confident: true });
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toMatchObject({ delimiter: "\t" });
    expect(detectDelimiter("a,b,c\n\"1,5\",2,3")).toMatchObject({ delimiter: "," });
  });
});

describe("pipeline: CSV and TSV", () => {
  it("imports a US CSV (Rails fixture style) with proven dates and a reconciled running balance", async () => {
    const csv = "Date,Description,Amount,Balance\n01/02/2026,ACME PAYROLL,\"2,500.00\",\"3,100.00\"\n01/13/2026,STARBUCKS #12,-5.75,\"3,094.25\"\n";
    const draft = await createDraft(enc(csv), "us.csv", context({ deviceCurrency: "USD" }));
    expect(draft.format).toBe("csv");
    expect(draft.needs).toEqual([]);
    expect(dates(draft)).toEqual(["2026-01-02", "2026-01-13"]);
    expect(amounts(draft)).toEqual([250000, -575]);
    expect(draft.rows.map((row) => row.direction)).toEqual(["credit", "debit"]);
    expect(draft.reconciliation[0]).toMatchObject({ runningBalanceBreaks: [], closing: { amountMinor: 309425, kind: "running_balance" }, opening: { amountMinor: 60000, kind: "derived" } });
    const plan = commitPlan(draft, context());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.statements[0].rows.map((row) => [row.bookedOn, row.amountCents, row.validationStatus])).toEqual([["2026-01-02", 250000, "verified"], ["2026-01-13", -575, "verified"]]);
    expect(plan.statements[0].closingBalanceCents).toBe(309425);
  });

  it("blocks an ambiguous UK date order until the person chooses it", async () => {
    const csv = "Date,Description,Paid out,Paid in,Balance\n03/04/2026,TESCO STORES,12.50,,100.00\n04/05/2026,SALARY,,1500.00,1600.00\n";
    const draft = await createDraft(enc(csv), "uk.csv", context({ deviceCurrency: "GBP" }));
    expect(draft.needs).toEqual(["dateOrder"]); // GBP comes from the database's confirmed currency
    expect(commitPlan(draft, context()).ok).toBe(false);
    const chosen = reviseDraft(draft, { conventions: { dateOrder: "dmy", currency: "GBP" } }, context({ deviceCurrency: "GBP" }));
    expect(chosen.needs).toEqual([]);
    expect(dates(chosen)).toEqual(["2026-04-03", "2026-05-04"]);
    expect(amounts(chosen)).toEqual([-1250, 150000]);
    expect(commitPlan(chosen, context({ deviceCurrency: "GBP" })).ok).toBe(true);
  });

  it("reads a German semicolon CSV with comma decimals and a preamble with account details", async () => {
    const csv = [
      "Kontonummer:;DE89 3704 0044 0532 0130 00", "Bank:;Beispielbank", "Währung:;EUR", "",
      "Buchungstag;Verwendungszweck;Betrag;Saldo", "02.03.2026;REWE Markt;-1.234,56;8.765,44", "15.03.2026;Gehalt;2.500,00;11.265,44",
    ].join("\n");
    const draft = await createDraft(enc(csv), "de.csv", context());
    expect(draft.format).toBe("csv");
    expect(draft.headerRow).toBe(3);
    expect(draft.preamble).toMatchObject({ institution: "Beispielbank", last4: "3000", currency: "EUR" });
    expect(draft.effective).toMatchObject({ decimal: ",", currency: "EUR", dateOrder: "dmy" });
    expect(amounts(draft)).toEqual([-123456, 250000]);
    expect(draft.rows[0].account.key).toBe("beispielbank|3000|unknown");
    expect(JSON.stringify(draft.rows)).not.toContain("0532 0130"); // full account number is not carried in records
  });

  it("reads a Chinese bank TSV with 收入/支出 columns and keeps Chinese descriptions exactly", async () => {
    const tsv = "账号\t6222 **** **** 1234\n币种\tCNY\n交易日期\t摘要\t收入\t支出\t余额\n2026-03-01\t工资 代发\t8,000.00\t\t10,000.00\n2026-03-02\t支付宝 美团外卖\t\t35.50\t9,964.50\n";
    const draft = await createDraft(enc(tsv), "招商银行.tsv", context());
    expect(draft.format).toBe("tsv");
    expect(draft.effective.currency).toBe("CNY");
    expect(draft.rows.map((row) => row.originalDescription)).toEqual(["工资 代发", "支付宝 美团外卖"]);
    expect(amounts(draft)).toEqual([800000, -3550]);
    expect(draft.rows[0].account.last4).toBe("1234");
    expect(draft.reconciliation[0].runningBalanceBreaks).toEqual([]);
  });

  it("asks which decimal separator applies when values could mean either", async () => {
    const csv = "Date,Description,Amount\n2026-03-01,Coffee,\"1,250\"\n2026-03-02,Tea,\"2,500\"\n";
    const draft = await createDraft(enc(csv), "x.csv", context({ deviceCurrency: "EUR" }));
    expect(draft.needs).toContain("decimal");
    const decided = reviseDraft(draft, { conventions: { decimal: ",", currency: "EUR" } }, context());
    expect(amounts(decided)).toEqual([125, 250]);
    const otherWay = reviseDraft(draft, { conventions: { decimal: ".", currency: "EUR" } }, context());
    expect(amounts(otherWay)).toEqual([125000, 250000]);
  });

  it("JPY has no minor unit: '1,000' is one thousand yen and fractional yen is rejected", async () => {
    const csv = "Date,Description,Amount,Currency\n2026-03-01,コンビニ,\"-1,000\",JPY\n2026-03-02,Oops,-10.50,JPY\n";
    const draft = await createDraft(enc(csv), "jp.csv", context());
    expect(draft.effective.currency).toBe("JPY");
    expect(draft.rows[0].amountMinor).toBe(-1000);
    expect(draft.rows[1].status).toBe("rejected");
    expect(codes(draft, 1)).toContain("amount_precision");
    const plan = commitPlan(draft, context());
    expect(plan.ok && plan.statements[0].rows[0].amountCents).toBe(-100000);
    expect(plan.ok && plan.statements[0].report.rejected).toEqual([{ row: 3, codes: ["amount_precision"] }]);
  });

  it("3-decimal currencies are parsed exactly but not committed to scale-2 storage", async () => {
    const csv = "Date,Description,Amount,Currency\n2026-03-01,Shop,-12.345,KWD\n";
    const draft = await createDraft(enc(csv), "kw.csv", context());
    expect(draft.rows[0].amountMinor).toBe(-12345);
    expect(draft.rows[0].status).toBe("rejected");
    expect(commitPlan(draft, context())).toMatchObject({ ok: false, blockers: [{ code: "currency_not_storable", currency: "KWD" }] });
  });

  it("rejects (and reports) foreign-currency rows instead of converting them", async () => {
    const csv = "Date,Description,Amount,Currency\n2026-03-01,Lunch,-20.00,USD\n2026-03-02,Paris hotel,-150.00,EUR\n";
    const draft = await createDraft(enc(csv), "fx.csv", context({ deviceCurrency: "USD" }));
    expect(draft.rows[1]).toMatchObject({ status: "rejected", amountMinor: -15000, currency: "USD" });
    expect(codes(draft, 1)).toContain("foreign_currency_row");
    expect(draft.rows[1].raw).toMatchObject({ Currency: "EUR", Amount: "-150.00" });
  });

  it("requires a sign convention for credit-card exports and honours CR/DR markers absolutely", async () => {
    const csv = "Credit card statement\nCard number: **** 9876\nDate,Description,Amount\n2026-03-01,GROCERY MART,45.10\n2026-03-05,PAYMENT THANK YOU,500.00 CR\n";
    const draft = await createDraft(enc(csv), "card.csv", context({ deviceCurrency: "USD" }));
    expect(draft.conventions.accountKind).toBe("credit_card");
    expect(draft.needs).toContain("amountSign");
    const inverted = reviseDraft(draft, { conventions: { amountSign: "invert" } }, context({ deviceCurrency: "USD" }));
    expect(amounts(inverted)).toEqual([-4510, 50000]);
    expect(codes(inverted, 1)).toContain("card_payment");
    expect(inverted.rows[1].category).toBe("Transfers");
  });

  it("merges wrapped description lines and rejects summary rows visibly", async () => {
    const csv = "Date,Description,Amount\n2026-03-01,AMAZON MARKETPLACE,-10.00\n,ORDER 123-456 SEATTLE,\nTotal,,-10.00\n";
    const draft = await createDraft(enc(csv), "wrap.csv", context({ deviceCurrency: "USD" }));
    expect(draft.rows).toHaveLength(2);
    expect(draft.rows[0].originalDescription).toBe("AMAZON MARKETPLACE ORDER 123-456 SEATTLE");
    expect(codes(draft, 0)).toContain("continuation_merged");
    expect(draft.rows[1]).toMatchObject({ status: "rejected" });
    expect(codes(draft, 1)).toContain("summary_row");
  });

  it("flags pending rows and unknown types for a decision", async () => {
    const csv = "Date,Description,Amount,Type,Status\n2026-03-01,Cafe,5.00,debit,Posted\n2026-03-02,Hotel hold,200.00,debit,Pending\n2026-03-03,Odd,1.00,zzz,Posted\n";
    const draft = await createDraft(enc(csv), "p.csv", context({ deviceCurrency: "USD" }));
    expect(amounts(draft)).toEqual([-500, -20000, 100]);
    expect(draft.rows[1]).toMatchObject({ pending: true, status: "needs_review" });
    expect(codes(draft, 2)).toContain("type_unknown");
    expect(draft.summary.undecided).toBe(2);
    expect(commitPlan(draft, context())).toMatchObject({ ok: false, blockers: [{ code: "undecided_rows", count: 2 }] });
    expect(suggestedDecision(draft.rows[1])).toBe("skip");
  });

  it("a person's edit is authoritative and recorded", async () => {
    const csv = "Date,Description,Amount\n2026-03-01,Mystery,abc\n";
    const draft = await createDraft(enc(csv), "e.csv", context({ deviceCurrency: "USD" }));
    expect(draft.rows[0].status).toBe("rejected");
    const fixed = reviseDraft(draft, { edits: { [draft.rows[0].id]: { amount: "-12.34", category: "Shopping" } } }, context({ deviceCurrency: "USD" }));
    expect(fixed.rows[0]).toMatchObject({ amountMinor: -1234, category: "Shopping", categorySource: "user", status: "valid" });
    const plan = commitPlan(fixed, context());
    expect(plan.ok && plan.statements[0].rows[0]).toMatchObject({ validationStatus: "user_confirmed", category: "Shopping", amountCents: -1234 });
    expect(draft.rows[0].amountMinor).toBeNull(); // the earlier draft is unchanged
  });

  it("does not depend on the interface language", async () => {
    const csv = "交易日期,摘要,金额\n2026-03-01,星巴克,-30.00\n";
    const a = await createDraft(enc(csv), "a.csv", context({ deviceCurrency: "CNY" }));
    const b = await createDraft(enc(csv), "a.csv", context({ deviceCurrency: "CNY" }));
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows)); // no locale input exists at all
  });

  it("refuses malformed, empty, binary and duplicate files with clear codes", async () => {
    const fail = async (bytes: Uint8Array, ctx = context()) => createDraft(bytes, "f.csv", ctx).then(() => "ok", (error: ImportPipelineError) => error.code);
    expect(await fail(new Uint8Array())).toBe("file_empty");
    expect(await fail(enc('Date,Description,Amount\n2026-01-01,"unclosed,1\n'))).toBe("csv_unclosed_quote");
    expect(await fail(new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43]))).toBe("not_text");
    expect(await fail(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toBe("xls_legacy");
    expect(await fail(new Uint8Array(11 * 1024 * 1024).fill(0x41))).toBe("file_too_large");
    const bytes = enc("Date,Description,Amount\n2026-01-01,x,1\n");
    const { sha256Hex } = await import("../src");
    expect(await fail(bytes, context({ existingFileHashes: new Set([await sha256Hex(bytes)]) }))).toBe("file_duplicate");
    expect(await fail(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]))).toBe("ocr_unavailable");
  });

  it("asks for a mapping when no header row is recognized", async () => {
    const csv = "2026-03-01,Coffee,-4.50\n2026-03-02,Salary,100.00\n";
    const draft = await createDraft(enc(csv), "n.csv", context({ deviceCurrency: "USD" }));
    expect(draft.headerRow).toBeNull();
    expect(draft.needs).toContain("mapping");
    const mapped = reviseDraft(draft, { mapping: { transactionDate: 0, description: 1, amount: 2 } }, context({ deviceCurrency: "USD" }));
    expect(amounts(mapped)).toEqual([-450, 10000]);
    const withSettings = reviseDraft(mapped, { conventions: { decimal: ",", currency: "EUR" } }, context());
    expect(reviseDraft(withSettings, { headerRow: null }, context()).conventions).toMatchObject({ decimal: ",", currency: "EUR" });
  });
});

describe("duplicates and transfers", () => {
  const existing = [
    { id: 1, bookedOn: "2026-03-01", amountCents: -500, description: "Coffee Shop", accountKey: null, bankReference: null },
    { id: 2, bookedOn: "2026-03-02", amountCents: -2000, description: "Grocer", accountKey: null, bankReference: "TX-2" },
  ];

  it("recognizes an overlapping statement but keeps genuine repeated purchases", async () => {
    // Two identical coffees on 03-01; only one is already stored, so the second is new.
    const csv = "Date,Description,Amount,Reference\n2026-03-01,Coffee Shop,-5.00,\n2026-03-01,Coffee Shop,-5.00,\n2026-03-02,Grocer (new text),-20.00,TX-2\n2026-03-03,Bakery,-3.00,\n";
    const draft = await createDraft(enc(csv), "overlap.csv", context({ deviceCurrency: "USD", existing }));
    expect(codes(draft, 0)).toContain("duplicate_overlap");
    expect(codes(draft, 1)).not.toContain("duplicate_overlap");
    expect(draft.rows[1].status).toBe("valid");
    expect(codes(draft, 2)).toContain("duplicate_bank_reference");
    expect(draft.rows[3].status).toBe("valid");
    // Overlap needs a decision; the bank-id duplicate is skipped by default.
    expect(commitPlan(draft, context()).ok).toBe(false);
    const decided = reviseDraft(draft, { decisions: { [draft.rows[0].id]: "skip" } }, context({ deviceCurrency: "USD", existing }));
    const plan = commitPlan(decided, context());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.statements[0].rows.map((row) => row.description)).toEqual(["Coffee Shop", "Bakery"]);
    expect(plan.statements[0].report).toMatchObject({ totalRows: 4, accepted: 2, skippedDuplicates: 2, skippedByUser: 0 });
  });

  it("scopes duplicates by account", async () => {
    const stored = [{ id: 9, bookedOn: "2026-03-01", amountCents: -500, description: "Coffee Shop", accountKey: "bank a|1111|checking", bankReference: null }];
    const csv = "Bank: Bank B\nAccount number: 000002222\nChecking account\nDate,Description,Amount\n2026-03-01,Coffee Shop,-5.00\n";
    const draft = await createDraft(enc(csv), "b.csv", context({ deviceCurrency: "USD", existing: stored }));
    expect(draft.rows[0].account.key).toBe("bank b|2222|checking");
    expect(draft.rows[0].status).toBe("valid");
  });

  it("suggests internal transfers between two of the person's accounts without recategorizing", async () => {
    const stored = [{ id: 5, bookedOn: "2026-03-02", amountCents: 40000, description: "From checking", accountKey: "bank|2222|savings", bankReference: null }];
    const csv = "Bank: Bank\nAccount number: 1111\nDate,Description,Amount\n2026-03-01,Online banking,-400.00\n";
    const draft = await createDraft(enc(csv), "t.csv", context({ deviceCurrency: "USD", existing: stored }));
    expect(codes(draft, 0)).toContain("possible_transfer");
    expect(draft.rows[0].status).toBe("valid");
  });

  it("flags a running balance that does not follow (a sign or parsing error)", async () => {
    const csv = "Date,Description,Amount,Balance\n2026-03-01,A,-10.00,90.00\n2026-03-02,B,-10.00,100.00\n";
    const draft = await createDraft(enc(csv), "bal.csv", context({ deviceCurrency: "USD" }));
    expect(codes(draft, 1)).toContain("balance_mismatch");
    expect(draft.rows[1].status).toBe("needs_review");
    const plan = commitPlan(reviseDraft(draft, { decisions: { [draft.rows[1].id]: "include" } }, context({ deviceCurrency: "USD" })), context());
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.statements[0].closingBalanceCents).toBeNull(); // an inconsistent running balance is not trusted
  });
});

describe("templates", () => {
  it("applies a saved template only to the exact same columns and asks again when the format changes", async () => {
    const headers = ["Datum", "Text", "Belopp"];
    const template = templateFrom({ id: "t1", name: "Swedbank", institution: "Swedbank", headers, mapping: { transactionDate: 0, description: 1, amount: 2 },
      conventions: { dateOrder: "ymd", decimal: ",", amountSign: "as_is", currency: "SEK", accountKind: "checking" }, now: "2026-01-01T00:00:00Z" });
    expect(template.fingerprint).toBe(headerFingerprint(headers));
    const csv = "Datum;Text;Belopp\n2026-03-01;ICA;-125,50\n";
    const draft = await createDraft(enc(csv), "se.csv", context({ templates: [template] }));
    expect(draft.templateMatch.status).toBe("matched");
    expect(draft.rows[0].amountMinor).toBe(-12550);
    const changed = "Datum;Text;Belopp;Saldo\n2026-03-01;ICA;-125,50;1000,00\n";
    expect(matchTemplate(["Datum", "Text", "Belopp", "Saldo"], [template], null).status).toBe("changed");
    const changedDraft = await createDraft(enc(changed), "se2.csv", context({ templates: [template] }));
    expect(changedDraft.needs).toContain("mapping");
    expect(reviseDraft(changedDraft, { confirmMapping: true, conventions: { currency: "SEK", decimal: "," } }, context()).needs).toEqual([]);
  });
});

describe("pipeline: Excel and OFX", () => {
  // Minimal xlsx writer for fixtures (deflate entries).
  function zip(files: Record<string, string>): Uint8Array {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc32 = (data: Uint8Array) => { let c = 0xffffffff; for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const parts: number[] = [];
    const central: number[] = [];
    const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
    const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    let count = 0;
    for (const [name, text] of Object.entries(files)) {
      const data = enc(text);
      const packed = new Uint8Array(deflateRawSync(data));
      const nameBytes = [...enc(name)];
      const offset = parts.length;
      const common = [...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(crc32(data)), ...u32(packed.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0)];
      parts.push(...u32(0x04034b50), ...common, ...nameBytes, ...packed);
      central.push(...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes);
      count += 1;
    }
    const start = parts.length;
    return new Uint8Array([...parts, ...central, ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count), ...u32(central.length), ...u32(start), ...u16(0)]);
  }

  it("imports an Excel sheet with typed dates and exact numbers", async () => {
    const xlsx = zip({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Transactions" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>',
      "xl/styles.xml": '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      "xl/sharedStrings.xml": "<sst><si><t>Date</t></si><si><t>Description</t></si><si><t>Amount</t></si><si><t>Rent</t></si><si><t>Refund 退款</t></si></sst>",
      "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" s="1"><v>46085</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>-1650.0000000000002</v></c></row>' +
        '<row r="3"><c r="A3" s="1"><v>46086</v></c><c r="B3" t="s"><v>4</v></c><c r="C3"><v>12.3</v></c></row></sheetData></worksheet>',
    });
    const draft = await createDraft(xlsx, "bank.xlsx", context({ deviceCurrency: "USD", existing: [] }));
    expect(draft.format).toBe("xlsx");
    expect(dates(draft)).toEqual(["2026-03-04", "2026-03-05"]);
    const usd = reviseDraft(draft, { conventions: { currency: "USD" } }, context());
    expect(amounts(usd)).toEqual([-165000, 1230]);
    expect(codes(usd, 0)).toContain("amount_float_rounded");
    expect(codes(usd, 1)).toContain("refund_or_reversal");
  });

  it("imports a multi-account OFX file into one statement per account, deduplicating by FITID", async () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>Synthetic Bank<FID>99</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>111122223333<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260301<DTEND>20260331
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260302<TRNAMT>-42.10<FITID>A1<NAME>HARDWARE STORE</STMTTRN>
<STMTTRN><TRNTYPE>XFER<DTPOSTED>20260303<TRNAMT>-300.00<FITID>A2<NAME>TO SAVINGS</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>1000.00<DTASOF>20260331</LEDGERBAL></STMTRS></STMTTRNRS>
<STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>444455556666<ACCTTYPE>SAVINGS</BANKACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>XFER<DTPOSTED>20260303<TRNAMT>300.00<FITID>B1<NAME>FROM CHECKING</STMTTRN></BANKTRANLIST>
</STMTRS></STMTTRNRS>
</BANKMSGSRSV1></OFX>`;
    const stored = [{ id: 3, bookedOn: "2026-03-02", amountCents: -4210, description: "HARDWARE STORE", accountKey: "synthetic bank|3333|checking", bankReference: "A1" }];
    const draft = await createDraft(enc(ofx), "multi.qfx", context({ deviceCurrency: "USD", existing: stored }));
    expect(draft.format).toBe("ofx");
    expect(draft.rows.map((row) => row.account.key)).toEqual(["synthetic bank|3333|checking", "synthetic bank|3333|checking", "synthetic bank|6666|savings"]);
    expect(codes(draft, 0)).toContain("duplicate_bank_reference");
    expect(codes(draft, 1)).toContain("possible_transfer");
    expect(codes(draft, 2)).toContain("possible_transfer");
    expect(JSON.stringify(draft)).not.toContain("111122223333");
    const plan = commitPlan(draft, context({ deviceCurrency: "USD" }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.statements.map((statement) => [statement.account.kind, statement.rows.length, statement.closingBalanceCents])).toEqual([["checking", 1, 100000], ["savings", 1, null]]);
    const hashes = await statementHashes(plan.statements);
    expect(new Set(hashes).size).toBe(2);
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });
});

describe("OCR (shared layout + confidence; engines are platform adapters)", () => {
  const word = (text: string, x: number, y: number, confidence: number | null = 0.99) => ({ text, x, y, width: text.length * 6, height: 10, confidence });
  const line = (...words: ReturnType<typeof word>[]) => words.map((item) => ({ ...item, words: [item] }));
  const page = (number: number, lines: ReturnType<typeof line>[]): OcrPage => ({ page: number, width: 600, height: 800, rotation: 0, lines: lines.flat() });
  const header = line(word("Date", 10, 10), word("Description", 100, 10), word("Debit", 300, 10), word("Credit", 400, 10), word("Balance", 500, 10));
  const result = (pages: OcrPage[], errors: OcrResult["errors"] = []): OcrResult => ({ engine: { id: "fake", version: "1" }, languages: ["en"], pages, errors, unsupported: [] });
  const page1 = page(1, [
    line(word("Opening balance: 100.00", 10, -10)), header,
    line(word("2026-03-01", 10, 30), word("Coffee", 100, 30), word("4.50", 300, 30), word("95.50", 500, 30)),
    // Debit column empty: the credit amount must stay in the Credit column.
    line(word("2026-03-02", 10, 50), word("Refund", 100, 50), word("10.00", 400, 50), word("105.50", 500, 50)),
    line(word("2026-03-03", 10, 70), word("Taxi", 100, 70), word("8.00", 300, 70, 0.6), word("97.50", 500, 70)),
  ]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const engineFor = (output: OcrResult): OcrEngine => ({ info: { id: "fake", location: "device", languages: ["en"] }, recognize: async () => output });

  it("keeps cells in their columns by position and flags low-confidence amounts", async () => {
    const table = layoutToTable([page1], "image");
    expect(table.rows[3].map((cell) => cell.text)).toEqual(["2026-03-02", "Refund", "", "10.00", "105.50"]);
    expect(table.rowBoxes?.[3]).toMatchObject({ x: 10, y: 50 });
    const engine = engineFor(result([page1]));
    const draft = await createDraft(png, "photo.png", context({ ocr: engine, deviceCurrency: "USD" }));
    expect(amounts(draft)).toEqual([-450, 1000, -800]);
    expect(draft.rows[0].source).toMatchObject({ format: "image", page: 1, box: { x: 10, y: 30 } });
    expect(draft.ocr?.engine).toEqual({ id: "fake", version: "1" });
    // Each row's amount is proven by the printed opening balance and the running balance.
    expect(draft.reconciliation[0].balanceVerified).toEqual(["r3", "r4", "r5"]);
    expect(draft.rows[0].status).toBe("valid");
    expect(draft.rows[2].status).toBe("needs_review");
    expect(codes(draft, 2)).toContain("low_confidence");
  });

  it("does not accept confident OCR rows that the statement's balances do not prove", async () => {
    const noBalance = page(1, [
      line(word("Date", 10, 10), word("Description", 100, 10), word("Amount", 300, 10)),
      line(word("2026-03-01", 10, 30), word("Coffee", 100, 30), word("-4.50", 300, 30)),
    ]);
    const draft = await createDraft(png, "photo.png", context({ ocr: engineFor(result([noBalance])), deviceCurrency: "USD" }));
    expect(draft.rows[0]).toMatchObject({ amountMinor: -450, status: "needs_review" });
    expect(codes(draft, 0)).toContain("ocr_unverified");
    expect(commitPlan(draft, context())).toMatchObject({ ok: false, blockers: [{ code: "undecided_rows", count: 1 }] });
    // The person's correction is authoritative and lifts the OCR doubt.
    const edited = reviseDraft(draft, { edits: { r2: { amount: "-4.50" } } }, context({ deviceCurrency: "USD" }));
    expect(edited.rows[0].status).toBe("valid");
  });

  it("joins pages in order, skips the repeated page header, and blocks on a page that failed", async () => {
    const page2 = page(2, [header, line(word("2026-03-04", 10, 30), word("Bus", 100, 30), word("2.50", 300, 30), word("95.00", 500, 30))]);
    const draft = await createOcrDraft({ bytes: png, filename: "scan.pdf", format: "pdf_scanned", images: [1, 2, 3].map((n) => ({ page: n, bytes: png, kind: "png" as const })) },
      context({ ocr: engineFor(result([page1, page2], [{ page: 3, code: "recognition_failed", message: "" }])), deviceCurrency: "USD" }));
    expect(draft.rows.map((row) => [row.source.page, row.transactionDate])).toEqual([[1, "2026-03-01"], [1, "2026-03-02"], [1, "2026-03-03"], [2, "2026-03-04"]]);
    expect(draft.fileIssues.map((item) => item.code)).toEqual(expect.arrayContaining(["repeated_header_skipped", "ocr_page_failed"]));
    expect(draft.ocr?.missingPages).toEqual([3]);
    expect(draft.needs).toContain("ocrPages");
    expect(reviseDraft(draft, { acknowledgeMissingPages: true }, context({ deviceCurrency: "USD" })).needs).not.toContain("ocrPages");
  });

  it("flags a line printed twice across pages (same balance) but not repeated purchases", async () => {
    const twice = page(2, [header, line(word("2026-03-03", 10, 30), word("Taxi", 100, 30), word("8.00", 300, 30), word("97.50", 500, 30))]);
    const draft = await createOcrDraft({ bytes: png, filename: "s.pdf", format: "pdf_scanned", images: [{ page: 1, bytes: png, kind: "png" }, { page: 2, bytes: png, kind: "png" }] },
      context({ ocr: engineFor(result([page1, twice])), deviceCurrency: "USD" }));
    expect(codes(draft, 3)).toContain("repeated_row_in_file");
    expect(codes(draft, 0)).not.toContain("repeated_row_in_file");
  });

  it("treats a missing engine confidence as low, never as certain", () => {
    const unknown = page(1, [header, line(word("2026-03-01", 10, 30), word("Coffee", 100, 30), word("4.50", 300, 30, null), word("95.50", 500, 30))]);
    expect(layoutToTable([unknown], "image").rows[1][2]).toMatchObject({ text: "4.50", confidence: 0.5 });
  });

  it("refuses all-failed recognition and malformed adapter output without inventing anything", async () => {
    await expect(createDraft(png, "p.png", context({ ocr: engineFor(result([], [{ page: 1, code: "decode_failed", message: "" }])) }))).rejects.toMatchObject({ code: "ocr_failed" });
    expect(parseOcrResult({ pages: [{ page: 1, width: 10, height: 10, lines: [{ text: "x", x: "bad" }, { text: "ok", x: 1, y: 1, width: 1, height: 1, confidence: 7 }] }] }).pages[0].lines)
      .toEqual([{ text: "ok", x: 1, y: 1, width: 1, height: 1, confidence: 1, words: [] }]);
  });

  it("never sends a document to a cloud engine without opt-in", async () => {
    const cloud: OcrEngine = { info: { id: "cloud", location: "cloud", languages: [] }, recognize: async () => { throw new Error("must not be called"); } };
    await expect(createDraft(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]), "scan.jpg", context({ ocr: cloud }))).rejects.toMatchObject({ code: "ocr_unavailable" });
  });
});
