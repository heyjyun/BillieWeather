// Synthetic fixtures only — no real bank data.
import { looksLikeOfx, OfxError, parseOfx, type OfxErrorCode } from "../src/universal/ofx";

const SGML_HEADER = [
  "OFXHEADER:100",
  "DATA:OFXSGML",
  "VERSION:102",
  "SECURITY:NONE",
  "ENCODING:USASCII",
  "CHARSET:1252",
  "COMPRESSION:NONE",
  "OLDFILEUID:NONE",
  "NEWFILEUID:NONE",
  "",
].join("\n");

// Line numbers matter for the sourceLine assertions: header is lines 1-9, <OFX> is line 10.
const SGML_BANK = `${SGML_HEADER}<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>20240201120000<LANGUAGE>ENG
<FI><ORG>Test Bank &amp; Trust<FID>9999</FI>
<INTU.BID>12345
</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>usd
<BANKACCTFROM><BANKID>021000021<BRANCHID>001<ACCTID>123456789012<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20240101<DTEND>20240131235959.000[-5:EST]
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240105120000[-5:EST]
<DTUSER>20240104
<TRNAMT>-12.34
<FITID>T1
<NAME>COFFEE   SHOP
<MEMO>Card purchase
</STMTTRN>
<STMTTRN><TRNTYPE>FEE<DTPOSTED>20240110<TRNAMT>-5.00<FITID>T2<NAME>MONTHLY FEE</STMTTRN>
<STMTTRN><TRNTYPE>XFER<DTPOSTED>20240112<TRNAMT>-100.00<FITID>T3<NAME>TRANSFER TO SAVINGS
<BANKACCTTO><BANKID>021000021<ACCTID>999988887777<ACCTTYPE>SAVINGS</BANKACCTTO>
</STMTTRN>
<STMTTRN><TRNTYPE>check<DTPOSTED>20240115<TRNAMT>-250.00<FITID>T4<CHECKNUM>1042<NAME>CHECK 1042</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240120<TRNAMT>5.00<FITID>T5<CORRECTFITID>T2<CORRECTACTION>REPLACE<NAME>FEE REVERSAL<MEMO></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1234.56<DTASOF>20240131</LEDGERBAL>
<AVAILBAL><BALAMT>1200.00<DTASOF>20240131120000</AVAILBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`;

const XML_CARD = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<!-- synthetic credit card statement -->
<OFX>
  <SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
    <DTSERVER>20240301</DTSERVER><LANGUAGE>ENG</LANGUAGE><FI><ORG>CardCo</ORG><FID>42</FID></FI></SONRS></SIGNONMSGSRSV1>
  <CREDITCARDMSGSRSV1>
    <CCSTMTTRNRS><TRNUID>0</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <CCSTMTRS>
        <CURDEF>USD</CURDEF>
        <CCACCTFROM><ACCTID>4111-1111-1111-9876</ACCTID></CCACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20240201000000.000[+8:CST]</DTSTART><DTEND>20240229</DTEND>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240205</DTPOSTED><TRNAMT>-45.67</TRNAMT><FITID>C1</FITID>
            <NAME>Caf&#233; &lt;Downtown&gt; &quot;Best&quot; &apos;s &#x4E2D;</NAME>
            <MEMO>  multi
              line   memo  </MEMO>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20240210</DTPOSTED><TRNAMT>+500</TRNAMT><FITID>C2</FITID>
            <PAYEE><NAME>Autopay</NAME><ADDR1>1 Main St</ADDR1></PAYEE>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>POS</TRNTYPE><DTPOSTED>20240215</DTPOSTED><TRNAMT>-30.00</TRNAMT><FITID>C3</FITID>
            <NAME>LONDON SHOP</NAME>
            <ORIGCURRENCY><CURRATE>1.2650</CURRATE><CURSYM>gbp</CURSYM></ORIGCURRENCY>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>INT</TRNTYPE><DTPOSTED>20240229</DTPOSTED><TRNAMT>-1,23</TRNAMT><FITID>C4</FITID>
            <CURRENCY><CURRATE>1.0</CURRATE><CURSYM>EUR</CURSYM></CURRENCY>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL><BALAMT>-1500.25</BALAMT><DTASOF>20240229</DTASOF></LEDGERBAL>
      </CCSTMTRS>
    </CCSTMTTRNRS>
  </CREDITCARDMSGSRSV1>
</OFX>
`;

const multiAccount = (eol: string) => [
  "OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "ENCODING:UTF-8", "CHARSET:NONE", "",
  "<ofx>",
  "<bankmsgsrsv1>",
  "<stmttrnrs><stmtrs><curdef>EUR",
  "<bankacctfrom><bankid>111<acctid>DE00CHECK0001234<accttype>CHECKING</bankacctfrom>",
  "<banktranlist><dtstart>20240301<dtend>20240331",
  "<stmttrn><trntype>DEBIT<dtposted>20240302<trnamt>-10.00<fitid>A1<name>超市购物<memo>早餐 &amp; 咖啡 ☕</stmttrn>",
  "<stmttrn><trntype>DIRECTDEP<dtposted>20240325<trnamt>2000.00<fitid>A2<name>SALARY</stmttrn>",
  "</banktranlist></stmtrs></stmttrnrs>",
  "<stmttrnrs><stmtrs><curdef>EUR",
  "<bankacctfrom><bankid>111<acctid>DE00SAVE0005678<accttype>savings</bankacctfrom>",
  "<banktranlist><dtstart>20240301<dtend>20240331",
  "<stmttrn><trntype>INT<dtposted>20240331<trnamt>1.23<fitid>B1<name>INTEREST</stmttrn>",
  "</banktranlist></stmtrs></stmttrnrs>",
  "</bankmsgsrsv1>",
  "</ofx>",
  "",
].join(eol);

/** Minimal SGML bank file around the given STMTTRN bodies. */
const sgmlWith = (trns: string, extra = "") =>
  `${SGML_HEADER}<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>1<ACCTID>555566667777<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>${trns}</BANKTRANLIST>${extra}</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

function codeOf(fn: () => unknown): OfxErrorCode | "no error" | "raw error" {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof OfxError ? e.code : "raw error";
  }
}

describe("looksLikeOfx", () => {
  it("recognises SGML headers, the OFX PI and a bare root; rejects CSV/PDF", () => {
    expect(looksLikeOfx(SGML_BANK)).toBe(true);
    expect(looksLikeOfx(XML_CARD)).toBe(true);
    expect(looksLikeOfx("  <ofx>\n<x>")).toBe(true);
    expect(looksLikeOfx("ofxheader: 100\n")).toBe(true);
    expect(looksLikeOfx("date,amount\n2024-01-01,1.00\n")).toBe(false);
    expect(looksLikeOfx("%PDF-1.7")).toBe(false);
    expect(looksLikeOfx(`${" ".repeat(5000)}<OFX>`)).toBe(false);
  });
});

describe("parseOfx: SGML v1 bank statement", () => {
  const doc = parseOfx(SGML_BANK);
  const st = doc.statements[0]!;

  it("reads document and statement metadata", () => {
    expect(doc.version).toBe("sgml");
    expect(doc.encodingHint).toBe("1252");
    expect(doc.institution).toEqual({ org: "Test Bank & Trust", fid: "9999" });
    expect(doc.statements).toHaveLength(1);
    expect(st).toMatchObject({
      kind: "bank", currency: "USD", bankId: "021000021", branchId: "001", accountLast4: "9012",
      accountType: "CHECKING", start: "2024-01-01", end: "2024-01-31",
      ledgerBalance: { amount: "1234.56", asOf: "2024-01-31" },
      availableBalance: { amount: "1200.00", asOf: "2024-01-31" },
    });
  });

  it("parses unclosed leaves into transactions in file order", () => {
    expect(st.transactions.map((t) => [t.index, t.trnType, t.posted, t.amount, t.fitId])).toEqual([
      [0, "DEBIT", "2024-01-05", "-12.34", "T1"],
      [1, "FEE", "2024-01-10", "-5.00", "T2"],
      [2, "XFER", "2024-01-12", "-100.00", "T3"],
      [3, "CHECK", "2024-01-15", "-250.00", "T4"],
      [4, "CREDIT", "2024-01-20", "5.00", "T5"],
    ]);
    const [t0, , t2, t3, t4] = st.transactions;
    expect(t0).toMatchObject({ userDate: "2024-01-04", name: "COFFEE SHOP", memo: "Card purchase", payee: null });
    expect(t2!.name).toBe("TRANSFER TO SAVINGS");
    expect(t3).toMatchObject({ checkNum: "1042", name: "CHECK 1042" });
    expect(t4).toMatchObject({ correctAction: "REPLACE", correctFitId: "T2", memo: null });
    expect(t0).toMatchObject({ currency: null, currencyRate: null, originalCurrency: false, refNum: null, sic: null });
  });

  it("records the 1-based line where each STMTTRN starts", () => {
    expect(st.transactions.map((t) => t.sourceLine)).toEqual([20, 29, 30, 33, 34]);
    expect(SGML_BANK.split("\n")[19]).toBe("<STMTTRN>");
  });

  it("never exposes the full account numbers", () => {
    const json = JSON.stringify(doc);
    expect(json).not.toContain("123456789012");
    expect(json).not.toContain("999988887777"); // BANKACCTTO of the transfer
  });
});

describe("parseOfx: XML v2 credit card statement", () => {
  const doc = parseOfx(XML_CARD);
  const st = doc.statements[0]!;

  it("reads CCSTMTRS", () => {
    expect(doc.version).toBe("xml");
    expect(doc.encodingHint).toBe("UTF-8");
    expect(doc.institution).toEqual({ org: "CardCo", fid: "42" });
    expect(st).toMatchObject({
      kind: "creditcard", currency: "USD", bankId: null, branchId: null, accountLast4: "9876",
      accountType: "CREDITCARD", start: "2024-02-01", end: "2024-02-29",
      ledgerBalance: { amount: "-1500.25", asOf: "2024-02-29" }, availableBalance: null,
    });
    expect(JSON.stringify(doc)).not.toMatch(/4111|1111-9876/);
  });

  it("decodes entities and collapses whitespace", () => {
    const t = st.transactions[0]!;
    expect(t.name).toBe("Café <Downtown> \"Best\" 's 中");
    expect(t.memo).toBe("multi line memo");
  });

  it("reads PAYEE aggregate names, raw amounts and currencies", () => {
    const [, pay, fx, eur] = st.transactions;
    expect(pay).toMatchObject({ trnType: "PAYMENT", amount: "+500", payee: "Autopay", name: null });
    expect(fx).toMatchObject({ currency: "GBP", currencyRate: "1.2650", originalCurrency: true, amount: "-30.00" });
    expect(eur).toMatchObject({ currency: "EUR", currencyRate: "1.0", originalCurrency: false, amount: "-1,23" });
  });
});

describe("parseOfx: multi-account, CRLF, case-insensitive tags, Unicode", () => {
  for (const [label, eol] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]] as const) {
    it(`parses both accounts with ${label} line endings`, () => {
      const doc = parseOfx(multiAccount(eol));
      expect(doc.encodingHint).toBe("UTF-8");
      expect(doc.institution).toEqual({ org: null, fid: null });
      expect(doc.statements.map((s) => [s.accountType, s.accountLast4, s.currency, s.transactions.length])).toEqual([
        ["CHECKING", "1234", "EUR", 2],
        ["SAVINGS", "5678", "EUR", 1],
      ]);
      const [a1, a2] = doc.statements[0]!.transactions;
      expect(a1).toMatchObject({ name: "超市购物", memo: "早餐 & 咖啡 ☕", sourceLine: 12, index: 0 });
      expect(a2).toMatchObject({ trnType: "DIRECTDEP", amount: "2000.00", sourceLine: 13, index: 1 });
      expect(doc.statements[1]!.transactions[0]).toMatchObject({ index: 0, sourceLine: 18, amount: "1.23" });
      const json = JSON.stringify(doc);
      expect(json).not.toContain("CHECK0001234");
      expect(json).not.toContain("SAVE0005678");
    });
  }

  it("ignores a leading BOM", () => {
    expect(parseOfx(`﻿${multiAccount("\n")}`).statements).toHaveLength(2);
  });
});

describe("parseOfx: dates", () => {
  const dated = (posted: string, user = "") =>
    parseOfx(sgmlWith(`<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${posted}${user ? `<DTUSER>${user}` : ""}<TRNAMT>-1<FITID>D</STMTTRN>`))
      .statements[0]!.transactions[0]!;

  it("takes the literal date part and ignores the timezone", () => {
    expect(dated("20240131230000.000[-5:EST]").posted).toBe("2024-01-31");
    expect(dated("20240101003000[+14]").posted).toBe("2024-01-01");
    expect(dated("20240229").posted).toBe("2024-02-29");
    expect(dated("20240115120000.123").posted).toBe("2024-01-15");
  });

  it("returns null for invalid or out-of-range dates", () => {
    for (const bad of ["20230229", "20241301", "20240132", "18991231", "21010101", "2024-01-15", "2024011", "garbage"]) {
      expect(dated(bad).posted).toBeNull();
    }
    expect(dated("19000101").posted).toBe("1900-01-01");
    expect(dated("21001231").posted).toBe("2100-12-31");
  });

  it("keeps posted null when both DTPOSTED and DTUSER are missing", () => {
    const t = parseOfx(sgmlWith("<STMTTRN><TRNTYPE>OTHER<TRNAMT>3.00<FITID>N</STMTTRN>")).statements[0]!.transactions[0]!;
    expect(t.posted).toBeNull();
    expect(t.userDate).toBeNull();
    expect(dated("bogus", "20240110")).toMatchObject({ posted: null, userDate: "2024-01-10" });
  });
});

describe("parseOfx: incomplete records and tolerance", () => {
  it("keeps a transaction without TRNAMT with amount ''", () => {
    const doc = parseOfx(sgmlWith(
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240101<FITID>X1<NAME>NO AMOUNT</STMTTRN>" +
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240102<TRNAMT><FITID>X2</STMTTRN>" +
      "<STMTTRN></STMTTRN>",
    ));
    const ts = doc.statements[0]!.transactions;
    expect(ts).toHaveLength(3);
    expect(ts[0]).toMatchObject({ amount: "", name: "NO AMOUNT", fitId: "X1" });
    expect(ts[1]).toMatchObject({ amount: "", fitId: "X2" });
    expect(ts[2]).toMatchObject({ amount: "", trnType: "", fitId: null, posted: null });
  });

  it("ignores unknown elements, comments and leaves explicitly closed in SGML", () => {
    const doc = parseOfx(sgmlWith(
      "<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><!-- note --><X.CUSTOM>abc<X.EMPTY><DTPOSTED>20240101</DTPOSTED>" +
      "<TRNAMT>-9.99</TRNAMT><FITID>U1<EXTRA.AGG><X.INNER>1</EXTRA.AGG><NAME>AT&T</NAME></STMTTRN>",
    ));
    expect(doc.statements[0]!.transactions[0]).toMatchObject({ trnType: "DEBIT", amount: "-9.99", name: "AT&T", fitId: "U1" });
  });

  it("does not expand DOCTYPE/ENTITY declarations", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE OFX [ <!ENTITY boom "EXPANDED"> ]><?OFX OFXHEADER="200"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>000011112222</ACCTID></CCACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><TRNAMT>-1.00</TRNAMT><NAME>&boom; &#0; &#xD800;</NAME></STMTTRN></BANKTRANLIST>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    const t = parseOfx(xml).statements[0]!.transactions[0]!;
    expect(t.name).toBe("&boom; &#0; &#xD800;");
    expect(t.sourceLine).toBe(3);
  });
});

describe("parseOfx: errors", () => {
  it("rejects non-OFX input", () => {
    expect(codeOf(() => parseOfx("date,amount\n2024-01-01,-1.00\n"))).toBe("ofx_not_ofx");
    expect(codeOf(() => parseOfx(""))).toBe("ofx_not_ofx");
    expect(codeOf(() => parseOfx(null as unknown as string))).toBe("ofx_not_ofx");
  });

  it("reports files without statements", () => {
    expect(codeOf(() => parseOfx(`${SGML_HEADER}<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>X</FI></SONRS></SIGNONMSGSRSV1></OFX>`)))
      .toBe("ofx_no_statements");
  });

  it("rejects truncated input instead of returning partial data", () => {
    const xmlCut = XML_CARD.slice(0, XML_CARD.indexOf("<STMTTRN>", XML_CARD.indexOf("C2")) + 40);
    expect(codeOf(() => parseOfx(xmlCut))).toBe("ofx_malformed");
    const sgmlCut = SGML_BANK.slice(0, SGML_BANK.indexOf("</BANKTRANLIST>"));
    expect(codeOf(() => parseOfx(sgmlCut))).toBe("ofx_malformed");
    expect(codeOf(() => parseOfx(SGML_BANK.slice(0, SGML_BANK.indexOf("<TRNAMT>-5.00") + 4)))).toBe("ofx_malformed");
    expect(codeOf(() => parseOfx(`${SGML_HEADER}`))).toBe("ofx_malformed");
  });

  it("rejects unbalanced aggregates and garbage", () => {
    // Missing </STMTTRN> before the next <STMTTRN> is not guessed.
    expect(codeOf(() => parseOfx(sgmlWith("<STMTTRN><TRNTYPE>DEBIT<TRNAMT>-1<STMTTRN><TRNTYPE>DEBIT<TRNAMT>-2</STMTTRN>"))))
      .toBe("ofx_malformed");
    expect(codeOf(() => parseOfx(sgmlWith("<STMTTRN><TRNAMT>-1</STMTTRN></STMTTRN>")))).toBe("ofx_malformed");
    expect(codeOf(() => parseOfx(sgmlWith("<STMTTRN>junk<TRNAMT>-1</STMTTRN>")))).toBe("ofx_malformed");
    expect(codeOf(() => parseOfx(sgmlWith("<STMTTRN><TRNAMT>-1</STMTTRN>stray text")))).toBe("ofx_malformed");
    expect(codeOf(() => parseOfx(sgmlWith("<STMTTRN><TRNAMT>-1 <5</STMTTRN>")))).toBe("ofx_malformed");
    expect(codeOf(() => parseOfx(sgmlWith("<STMTTRN><!-- never closed <TRNAMT>-1</STMTTRN>")))).toBe("ofx_malformed");
    expect(codeOf(() => parseOfx(`<OFX>${"<A>".repeat(500)}`))).toBe("ofx_malformed");
  });

  it("enforces size and transaction limits", () => {
    expect(codeOf(() => parseOfx(SGML_BANK, { maxBytes: 100 }))).toBe("ofx_too_large");
    expect(codeOf(() => parseOfx(SGML_BANK, { maxTransactions: 4 }))).toBe("ofx_too_large");
    expect(parseOfx(SGML_BANK, { maxTransactions: 5 }).statements[0]!.transactions).toHaveLength(5);
    expect(codeOf(() => parseOfx(multiAccount("\n"), { maxTransactions: 2 }))).toBe("ofx_too_large"); // counted across accounts
    expect(codeOf(() => parseOfx(`<OFX>${" ".repeat(10 * 1024 * 1024)}</OFX>`))).toBe("ofx_too_large");
  });

  it("error details never contain account numbers or values", () => {
    try {
      parseOfx(sgmlWith("<STMTTRN><TRNAMT>-1<STMTTRN>"));
      throw new Error("expected failure");
    } catch (e) {
      expect(e).toBeInstanceOf(OfxError);
      expect((e as OfxError).message).not.toContain("555566667777");
      expect((e as OfxError).message).toMatch(/STMTTRN/);
    }
  });
});
