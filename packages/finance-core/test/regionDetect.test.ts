// Rule-based statement region detection and the region validator. Synthetic data only.
import { checkRegion, detectRegion, NO_DETECTION, parseDetection, serializeDetection, validAbaRouting, validClabe, validIban } from "../src";

const lines = (...list: string[]) => list.join("\n");

describe("checksums", () => {
  it("ABA routing numbers, IBANs and CLABEs are checked, not just their length", () => {
    expect(validAbaRouting("021000021")).toBe(true);
    expect(validAbaRouting("021000022")).toBe(false);
    expect(validAbaRouting("000000000")).toBe(false);
    expect(validIban("DE89370400440532013000")).toBe(true);
    expect(validIban("GB82WEST12345698765432")).toBe(true);
    expect(validIban("DE89370400440532013001")).toBe(false);
    expect(validClabe("032180000118359719")).toBe(true);
    expect(validClabe("032180000118359718")).toBe(false);
  });
});

describe("detectRegion", () => {
  it("United States: bank name, routing number, address and Zelle give High confidence", () => {
    const result = detectRegion({
      text: lines("JPMorgan Chase Bank, N.A.", "PO Box 659754, San Antonio, TX 78265-9754", "Routing number: 021000021",
        "03/02/2026 Zelle payment to J Smith -40.00", "03/04/2026 Venmo cashout 25.00"),
      currency: "USD", dateOrder: "mdy",
    });
    expect(result.detectedRegion).toBe("US");
    expect(result.confidence).toBe("high");
    expect(result.evidence.map((item) => item.signal)).toEqual(expect.arrayContaining(["bank", "routing_number", "postal_address", "payment_network", "currency", "date_format"]));
    expect(result.conflictingEvidence).toEqual([]);
  });

  it("USD alone is weak: it never makes a confident detection", () => {
    const result = detectRegion({ text: "2026-03-01 Coffee -4.00", currency: "USD" });
    expect(result.detectedRegion).toBe("US");
    expect(result.confidence).toBe("low");
    expect(checkRegion(null, result).kind).toBe("none");
    expect(checkRegion("SG", result).kind).toBe("none");
  });

  it("Chinese text is not evidence of Mainland China; a mainland bank is", () => {
    const traditional = detectRegion({ text: lines("交易日期 摘要 金額", "2026-03-01 便利店 -32.00", "2026-03-02 轉帳 -100.00"), currency: null });
    expect(traditional).toEqual(NO_DETECTION);
    const simplified = detectRegion({ text: lines("日期 摘要 金额", "2026-03-01 便利店 -32.00"), currency: null });
    expect(simplified).toEqual(NO_DETECTION);
    const icbc = detectRegion({ text: lines("中国工商银行 借记卡账户历史明细", "2026-03-01 美团外卖 -32.00"), currency: "CNY" });
    expect(icbc.detectedRegion).toBe("CN");
    expect(icbc.confidence).toBe("high");
  });

  it("Bank of China (Hong Kong) is Hong Kong, not Mainland China", () => {
    const result = detectRegion({ text: "中國銀行(香港)有限公司 結單 轉數快 FPS", currency: "HKD" });
    expect(result.detectedRegion).toBe("HK");
    expect(result.confidence).toBe("high");
    expect(detectRegion({ text: "中国银行（香港）" }).detectedRegion).toBe("HK");
  });

  it("IBAN countries are read from valid IBANs only", () => {
    const de = detectRegion({ text: "Kontoauszug IBAN: DE89 3704 0044 0532 0130 00 BIC COBADEFFXXX", currency: "EUR" });
    expect(de.detectedRegion).toBe("DE");
    expect(de.evidence[0]).toMatchObject({ signal: "iban", detail: "DE" });
    expect(de.confidence).toBe("high");
    expect(detectRegion({ text: "IBAN DE89 3704 0044 0532 0130 01" })).toEqual(NO_DETECTION);
    // An IBAN followed directly by other words on the same line is still recognized.
    expect(detectRegion({ text: "GB82 WEST 1234 5698 7654 32 SORT CODE" }).detectedRegion).toBe("GB");
  });

  it("other account formats: sort code, BSB, IFSC, CLABE, Canadian transit, NZ account", () => {
    expect(detectRegion({ text: "Sort code 20-00-00 Account 12345678" }).detectedRegion).toBe("GB");
    expect(detectRegion({ text: "Sort code 90-00-17" }).detectedRegion).toBe("IE");
    expect(detectRegion({ text: "BSB 062-000 Account 1234 5678" }).detectedRegion).toBe("AU");
    expect(detectRegion({ text: "IFSC: HDFC0001234" }).detectedRegion).toBe("IN");
    expect(detectRegion({ text: "CLABE 032180000118359719" }).detectedRegion).toBe("MX");
    expect(detectRegion({ text: "CLABE 032180000118359718" })).toEqual(NO_DETECTION);
    expect(detectRegion({ text: "Transit number: 12345" }).detectedRegion).toBe("CA");
    expect(detectRegion({ text: "Account 12-3456-1234567-00" }).detectedRegion).toBe("NZ");
  });

  it("OFX BANKID counts as a routing number only when its checksum is valid", () => {
    expect(detectRegion({ text: "", bankIds: ["021000021"] }).detectedRegion).toBe("US");
    expect(detectRegion({ text: "", bankIds: ["123456789"] })).toEqual(NO_DETECTION);
  });

  it("payment networks alone are Medium at most", () => {
    const result = detectRegion({ text: lines("Interac e-Transfer from A", "Interac purchase"), currency: "CAD" });
    expect(result.detectedRegion).toBe("CA");
    expect(result.confidence).toBe("medium");
    expect(checkRegion(null, result).kind).toBe("none");
    expect(checkRegion("US", result).kind).toBe("none");
  });

  it("merchant names that contain a place are not address evidence", () => {
    expect(detectRegion({ text: lines("HONG KONG EXPRESS RESTAURANT -12.00", "CANADA GOOSE STORE -800.00", "HALIFAX NS GROCERY -10.00") })).toEqual(NO_DETECTION);
  });

  it("conflicting evidence is reported and lowers confidence", () => {
    const result = detectRegion({ text: lines("Wells Fargo Bank", "Interac e-Transfer", "Scotiabank"), currency: "USD" });
    expect(result.detectedRegion).toBe("CA");
    expect(result.confidence).not.toBe("high");
    expect(result.conflictingEvidence.map((item) => item.region)).toContain("US");
  });

  it("a tie between regions detects nothing", () => {
    const result = detectRegion({ text: lines("Wells Fargo", "Scotiabank") });
    expect(result.detectedRegion).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.conflictingEvidence).toHaveLength(2);
  });

  it("is deterministic and evidence never contains document text or numbers", () => {
    const input = { text: lines("Bank of America", "Routing 021000021", "Account 0000 1234 5678", "Payee SECRET PERSON"), currency: "USD" };
    expect(detectRegion(input)).toEqual(detectRegion(input));
    const stored = serializeDetection(detectRegion(input));
    expect(stored).not.toMatch(/021000021|5678|SECRET/);
  });
});

describe("checkRegion (the validator)", () => {
  const us = detectRegion({ text: lines("Bank of America", "Routing number 021000021"), currency: "USD" });

  it("A: nothing selected and High confidence: suggest; otherwise stay Not specified", () => {
    expect(checkRegion(null, us)).toEqual({ kind: "suggest", detected: "US" });
    expect(checkRegion("", us)).toEqual({ kind: "suggest", detected: "US" });
    expect(checkRegion(null, NO_DETECTION)).toEqual({ kind: "none" });
  });

  it("B: the selection matches", () => {
    expect(checkRegion("US", us)).toEqual({ kind: "match", detected: "US" });
  });

  it("C: the selection conflicts with strong evidence: warn, never override", () => {
    expect(checkRegion("CN", us)).toEqual({ kind: "conflict", selected: "CN", detected: "US" });
    // After "Keep my selection" the warning is not shown again.
    expect(checkRegion("CN", us, { keptSelection: true })).toEqual({ kind: "none" });
  });

  it("D: insufficient evidence: no prompt", () => {
    const weak = detectRegion({ text: "Venmo", currency: "USD" });
    expect(weak.confidence).not.toBe("high");
    expect(checkRegion("CN", weak)).toEqual({ kind: "none" });
    expect(checkRegion(null, weak)).toEqual({ kind: "none" });
  });
});

describe("stored detection", () => {
  it("round-trips, and damaged values read as no detection", () => {
    const detection = detectRegion({ text: "Barclays Bank UK PLC Sort code 20-00-00", currency: "GBP" });
    expect(parseDetection(detection.detectedRegion, detection.confidence, serializeDetection(detection))).toEqual(detection);
    expect(parseDetection("XX", "high", "{}")).toEqual(NO_DETECTION);
    expect(parseDetection("US", "certain", "not json").detectedRegion).toBeNull();
    expect(parseDetection(null, null, null)).toEqual(NO_DETECTION);
  });
});
