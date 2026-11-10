import { deflateRawSync } from "node:zlib";
import { isDateFormatCode, looksLikeXlsx, readXlsx, XlsxError, type XlsxCell, type XlsxErrorCode } from "../src/universal/xlsx";

// --- tiny ZIP writer (synthetic fixtures only) -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface FileSpec {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8;
  flags?: number;
  /** Overrides written into both headers (to forge lies). */
  declaredMethod?: number;
  declaredSize?: number;
}

const enc = new TextEncoder();

function zip(files: FileSpec[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const data = typeof file.data === "string" ? enc.encode(file.data) : file.data;
    const method = file.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const name = enc.encode(file.name);
    const crc = crc32(data);
    const flags = 0x0800 | (file.flags ?? 0);
    const declaredMethod = file.declaredMethod ?? method;
    const size = file.declaredSize ?? data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, declaredMethod, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, flags, true);
    central.setUint16(10, declaredMethod, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = centrals.reduce((sum, p) => sum + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...parts, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((sum, p) => sum + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// --- xlsx fixture helpers ---------------------------------------------------------------------------------

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

interface BookSpec {
  sheets?: Array<{ name: string; rows: string; target?: string; path?: string; state?: string; rid?: string }>;
  sharedStrings?: string[]; // raw <si> inner XML
  styles?: string; // raw styles.xml
  workbookPr?: string;
  method?: 0 | 8;
  extra?: FileSpec[];
  override?: Partial<Record<string, Partial<FileSpec>>>;
}

function sheetXml(rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`;
}

function book(spec: BookSpec = {}): Uint8Array {
  const sheets = spec.sheets ?? [{ name: "Sheet1", rows: `<row r="1"><c r="A1"><v>1</v></c></row>` }];
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}>${spec.workbookPr ?? ""}<sheets>${sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="${s.rid ?? `rId${i + 1}`}"${s.state ? ` state="${s.state}"` : ""}/>`)
    .join("")}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((s, i) => `<Relationship Id="${s.rid ?? `rId${i + 1}`}" Type="${REL}/worksheet" Target="${s.target ?? `worksheets/sheet${i + 1}.xml`}"/>`)
    .join("")}<Relationship Id="rIdSS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdSt" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
  const files: FileSpec[] = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: rels },
  ];
  sheets.forEach((s, i) => {
    const target = s.target ?? `worksheets/sheet${i + 1}.xml`;
    const path = s.path ?? (target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    files.push({ name: path, data: sheetXml(s.rows) });
  });
  if (spec.sharedStrings) {
    files.push({ name: "xl/sharedStrings.xml", data: `<sst ${NS} count="${spec.sharedStrings.length}">${spec.sharedStrings.map((si) => `<si>${si}</si>`).join("")}</sst>` });
  }
  if (spec.styles) files.push({ name: "xl/styles.xml", data: spec.styles });
  files.push(...(spec.extra ?? []));
  return zip(files.map((f) => ({ method: spec.method, ...f, ...(spec.override?.[f.name] ?? {}) })));
}

function styles(numFmts: Array<[number, string]>, xfIds: number[]): string {
  const fmts = numFmts.length
    ? `<numFmts count="${numFmts.length}">${numFmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code.replace(/"/g, "&quot;")}"/>`).join("")}</numFmts>`
    : "";
  return `<styleSheet ${NS}>${fmts}<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs><cellXfs count="${xfIds.length}">${xfIds
    .map((id) => `<xf numFmtId="${id}" applyNumberFormat="1"/>`)
    .join("")}</cellXfs></styleSheet>`;
}

async function firstSheet(spec: BookSpec): Promise<XlsxCell[][]> {
  return (await readXlsx(book(spec))).sheets[0].rows;
}

async function expectCode(promise: Promise<unknown>, code: XlsxErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(XlsxError);
  expect((caught as XlsxError).code).toBe(code);
}

const str = (text: string): XlsxCell => ({ kind: "string", text });
const num = (text: string): XlsxCell => ({ kind: "number", text });
const E: XlsxCell = { kind: "empty" };

// --- tests ------------------------------------------------------------------------------------------------

describe("readXlsx strings", () => {
  it("reads shared strings incl. CJK, emoji, entities, rich text, and skips phonetic runs", async () => {
    const rows = await firstSheet({
      sharedStrings: [
        `<t>工资 Salary</t>`,
        `<t>咖啡 ☕ &amp; 🍰 &#x1F600;&#128512; &lt;ok&gt; &quot;q&quot; &apos;a&apos;</t>`,
        `<r><rPr><b/></rPr><t xml:space="preserve">Rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>フリガナ</t></rPh><phoneticPr fontId="1"/>`,
        `<t xml:space="preserve">  padded  </t>`,
        `<t>line_x000D_break <![CDATA[<raw> & stuff]]></t>`,
        `<t/>`,
      ],
      sheets: [{
        name: "S",
        rows: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>`,
      }],
    });
    expect(rows).toEqual([[
      str("工资 Salary"),
      str("咖啡 ☕ & 🍰 😀😀 <ok> \"q\" 'a'"),
      str("Rich text"),
      str("  padded  "),
      str("line\rbreak <raw> & stuff"),
      str(""),
    ]]);
  });

  it("reads inline strings and formula string results", async () => {
    const rows = await firstSheet({
      sheets: [{
        name: "S",
        rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>Inline 中文</t></is></c><c r="B1" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r></is></c><c r="C1" t="str"><f>A1&amp;"!"</f><v>Inline 中文!</v></c></row>`,
      }],
    });
    expect(rows).toEqual([[str("Inline 中文"), str("ab"), str("Inline 中文!")]]);
  });

  it("rejects an out-of-range shared string index", async () => {
    await expectCode(readXlsx(book({ sharedStrings: ["<t>a</t>"], sheets: [{ name: "S", rows: `<row><c t="s"><v>5</v></c></row>` }] })), "xlsx_malformed");
  });
});

describe("readXlsx numbers and values", () => {
  it("keeps number text exactly as stored", async () => {
    const rows = await firstSheet({
      sheets: [{
        name: "S",
        rows: `<row r="1"><c r="A1"><v>-1234.56</v></c><c r="B1" t="n"><v>0.30000000000000004</v></c><c r="C1"><v>1E-3</v></c><c r="D1"><v>12345678901234567890.123</v></c></row>`,
      }],
    });
    expect(rows).toEqual([[num("-1234.56"), num("0.30000000000000004"), num("1E-3"), num("12345678901234567890.123")]]);
  });

  it("reads booleans, errors and formula cached values", async () => {
    const rows = await firstSheet({
      sheets: [{
        name: "S",
        rows: `<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="e"><v>#DIV/0!</v></c><c r="D1"><f>SUM(1,2)</f><v>3</v></c><c r="E1"><f>NOW()</f></c></row>`,
      }],
    });
    expect(rows).toEqual([[{ kind: "boolean", value: true }, { kind: "boolean", value: false }, { kind: "error", text: "#DIV/0!" }, num("3")]]);
  });

  it("pads missing cells and rows, supports omitted r, trims trailing empty rows", async () => {
    const rows = await firstSheet({
      sheets: [{
        name: "S",
        rows: `<row r="2"><c r="C2"><v>1</v></c></row><row><c><v>2</v></c><c><v>3</v></c><c r="E3"><v>4</v></c><c><v>5</v></c></row><row r="5"><c r="A5" s="0"/></row><row r="9"/>`,
      }],
    });
    expect(rows).toEqual([
      [],
      [E, E, num("1")],
      [num("2"), num("3"), E, E, num("4"), num("5")],
    ]);
  });

  it("parses cell references up to XFD1048576 and rejects beyond", async () => {
    const rows = await readXlsx(book({ sheets: [{ name: "S", rows: `<row r="1"><c r="AA1"><v>7</v></c></row>` }] }));
    expect(rows.sheets[0].rows[0][26]).toEqual(num("7"));
    expect(rows.sheets[0].rows[0]).toHaveLength(27);
    await expectCode(readXlsx(book({ sheets: [{ name: "S", rows: `<row><c r="XFE1"><v>1</v></c></row>` }] })), "xlsx_malformed");
    await expectCode(readXlsx(book({ sheets: [{ name: "S", rows: `<row><c r="A1048577"><v>1</v></c></row>` }] })), "xlsx_malformed");
    // A legal but huge reference makes the padded output exceed maxCells.
    await expectCode(readXlsx(book({ sheets: [{ name: "S", rows: `<row><c r="XFD1048576"><v>1</v></c></row>` }] })), "xlsx_too_large");
  });

  it("enforces maxCells", async () => {
    const cells = Array.from({ length: 20 }, (_, i) => `<c><v>${i}</v></c>`).join("");
    await expectCode(readXlsx(book({ sheets: [{ name: "S", rows: `<row>${cells}</row>` }] }), { maxCells: 10 }), "xlsx_too_large");
    const ok = await readXlsx(book({ sheets: [{ name: "S", rows: `<row>${cells}</row>` }] }), { maxCells: 20 });
    expect(ok.sheets[0].rows[0]).toHaveLength(20);
  });
});

describe("readXlsx dates", () => {
  const dateStyles = styles([[164, "yyyy\\-mm\\-dd"], [165, "dd/mm/yyyy hh:mm"], [166, "#,##0.00"], [167, "[h]:mm:ss"], [168, "\"day\" 0"]], [0, 14, 164, 165, 166, 167, 168, 22]);

  it("converts built-in and custom date formats exactly", async () => {
    const rows = await firstSheet({
      styles: dateStyles,
      sheets: [{
        name: "S",
        rows: `<row r="1"><c r="A1" s="1"><v>45292</v></c><c r="B1" s="2"><v>45337</v></c><c r="C1" s="3"><v>45337.5</v></c><c r="D1" s="3"><v>45337.999999</v></c><c r="E1" s="1"><v>45292.75</v></c></row>` +
          `<row r="2"><c r="A2" s="0"><v>45292</v></c><c r="B2" s="4"><v>45292</v></c><c r="C2" s="5"><v>1.5</v></c><c r="D2" s="6"><v>3</v></c><c r="E2" s="7"><v>1</v></c></row>` +
          `<row r="3"><c r="A3" s="1"><v>59</v></c><c r="B3" s="1"><v>60</v></c><c r="C3" s="1"><v>61</v></c><c r="D3" s="1"><v>0.5</v></c><c r="E3" s="1"><v>-1</v></c><c r="F3" s="1"><v>2958465</v></c><c r="G3" s="1"><v>2958466</v></c><c r="H3" s="1"><v>4.5292E4</v></c></row>`,
      }],
    });
    expect(rows[0]).toEqual([
      { kind: "date", iso: "2024-01-01", time: null },
      { kind: "date", iso: "2024-02-15", time: null },
      { kind: "date", iso: "2024-02-15", time: "12:00:00" },
      { kind: "date", iso: "2024-02-16", time: null }, // rounds to midnight of the next day
      { kind: "date", iso: "2024-01-01", time: "18:00:00" },
    ]);
    // General, number, elapsed-duration and quoted-literal formats stay numbers.
    expect(rows[1]).toEqual([num("45292"), num("45292"), num("1.5"), num("3"), { kind: "date", iso: "1900-01-01", time: null }]);
    const invalid = { kind: "error", text: "#INVALID_DATE" };
    expect(rows[2]).toEqual([
      { kind: "date", iso: "1900-02-28", time: null },
      invalid, // Excel's fictitious 1900-02-29
      { kind: "date", iso: "1900-03-01", time: null },
      invalid,
      invalid,
      { kind: "date", iso: "9999-12-31", time: null },
      invalid,
      { kind: "date", iso: "2024-01-01", time: null },
    ]);
  });

  it("honors the 1904 date system", async () => {
    for (const flag of ["1", "true"]) {
      const rows = await firstSheet({
        workbookPr: `<workbookPr date1904="${flag}"/>`,
        styles: styles([], [14]),
        sheets: [{ name: "S", rows: `<row><c s="0"><v>0</v></c><c s="0"><v>43830</v></c><c s="0"><v>60</v></c></row>` }],
      });
      expect(rows[0]).toEqual([
        { kind: "date", iso: "1904-01-01", time: null },
        { kind: "date", iso: "2024-01-01", time: null },
        { kind: "date", iso: "1904-03-01", time: null },
      ]);
    }
  });

  it("classifies format codes", () => {
    expect(isDateFormatCode("yyyy\\-mm\\-dd")).toBe(true);
    expect(isDateFormatCode("dd/mm/yyyy hh:mm")).toBe(true);
    expect(isDateFormatCode("[$-409]h:mm AM/PM")).toBe(true);
    expect(isDateFormatCode("[Red]#,##0.00;-#,##0.00")).toBe(false);
    expect(isDateFormatCode("General")).toBe(false);
    expect(isDateFormatCode("0.00E+00")).toBe(false);
    expect(isDateFormatCode("\"Days:\" 0")).toBe(false);
    expect(isDateFormatCode("[h]:mm:ss")).toBe(false);
  });
});

describe("readXlsx workbook structure", () => {
  it("returns sheets in workbook order, resolving relative and absolute rels targets", async () => {
    const wb = await readXlsx(book({
      sheets: [
        { name: "Zeta", rows: `<row><c><v>1</v></c></row>`, target: "/xl/worksheets/zz.xml", rid: "rId9" },
        { name: "Alpha &amp; 中", rows: `<row><c><v>2</v></c></row>`, target: "worksheets/../worksheets/aa.xml", path: "xl/worksheets/aa.xml", rid: "rId2" },
        { name: "Hidden", rows: ``, state: "hidden", rid: "rId5" },
      ],
    }));
    expect(wb.sheets.map((s) => [s.name, s.state])).toEqual([["Zeta", "visible"], ["Alpha & 中", "visible"], ["Hidden", "hidden"]]);
    expect(wb.sheets[0].rows).toEqual([[num("1")]]);
    expect(wb.sheets[1].rows).toEqual([[num("2")]]);
    expect(wb.sheets[2].rows).toEqual([]);
  });

  it("reads stored and deflated entries alike", async () => {
    const spec: BookSpec = { sharedStrings: ["<t>x</t>"], sheets: [{ name: "S", rows: `<row><c t="s"><v>0</v></c><c><v>2.5</v></c></row>` }] };
    const stored = await readXlsx(book({ ...spec, method: 0 }));
    const deflated = await readXlsx(book({ ...spec, method: 8 }));
    expect(stored).toEqual(deflated);
    expect(stored.sheets[0].rows).toEqual([[str("x"), num("2.5")]]);
  });

  it("reports a workbook without sheets", async () => {
    await expectCode(readXlsx(book({ sheets: [] })), "xlsx_no_sheets");
  });

  it("rejects a missing sheet part", async () => {
    const bytes = zip([
      { name: "xl/workbook.xml", data: `<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId1" Target="worksheets/missing.xml"/></Relationships>` },
    ]);
    await expectCode(readXlsx(bytes), "xlsx_malformed");
  });
});

describe("readXlsx hostile and broken input", () => {
  it("detects legacy CFB (.xls / encrypted .xlsx)", async () => {
    const cfb = new Uint8Array(512);
    cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expectCode(readXlsx(cfb), "xlsx_legacy_xls");
    expect(looksLikeXlsx(cfb)).toBe(false);
  });

  it("rejects non-zip input", async () => {
    await expectCode(readXlsx(enc.encode("Date,Amount\n2024-01-01,1.00\n")), "xlsx_not_zip");
    await expectCode(readXlsx(new Uint8Array(0)), "xlsx_not_zip");
  });

  it("rejects truncated zips", async () => {
    const bytes = book();
    await expectCode(readXlsx(bytes.subarray(0, bytes.length - 10)), "xlsx_malformed");
    await expectCode(readXlsx(bytes.subarray(0, Math.floor(bytes.length / 2))), "xlsx_malformed");
  });

  it("rejects corrupted entry data via CRC / inflate failure", async () => {
    const bytes = book({ method: 0 }).slice();
    const at = new TextDecoder().decode(bytes).indexOf("<sheets>");
    bytes[at + 1] = "X".charCodeAt(0);
    await expectCode(readXlsx(bytes), "xlsx_malformed");
  });

  it("aborts a zip bomb quickly (declared size over the limit)", async () => {
    const bomb = new Uint8Array(40 * 1024 * 1024).fill(0x20);
    const withBomb = zip([
      { name: "xl/workbook.xml", data: `<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: "xl/worksheets/sheet1.xml", data: bomb },
    ]);
    expect(withBomb.length).toBeLessThan(200 * 1024);
    const start = Date.now();
    await expectCode(readXlsx(withBomb, { maxEntryBytes: 1024 * 1024 }), "xlsx_too_large");
    await expectCode(readXlsx(withBomb), "xlsx_too_large"); // 40 MiB > default 32 MiB per entry
    await expectCode(readXlsx(withBomb, { maxTotalBytes: 1024 * 1024 }), "xlsx_too_large");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("aborts a zip bomb that lies about its uncompressed size while streaming", async () => {
    const bomb = new Uint8Array(40 * 1024 * 1024).fill(0x20);
    const withBomb = zip([
      { name: "xl/workbook.xml", data: `<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: "xl/worksheets/sheet1.xml", data: bomb, declaredSize: 1000 },
    ]);
    const start = Date.now();
    await expectCode(readXlsx(withBomb), "xlsx_malformed");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("rejects DOCTYPE / entity declarations (billion laughs)", async () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><worksheet ${NS}><sheetData><row><c t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>`;
    const bytes = book({ override: { "xl/worksheets/sheet1.xml": { data: laughs } } });
    await expectCode(readXlsx(bytes), "xlsx_malformed");
  });

  it("rejects unknown entities and malformed XML", async () => {
    await expectCode(readXlsx(book({ sheets: [{ name: "S", rows: `<row><c t="inlineStr"><is><t>&nbsp;</t></is></c></row>` }] })), "xlsx_malformed");
    await expectCode(readXlsx(book({ sheets: [{ name: "S", rows: `<row><c><v>1</v></row>` }] })), "xlsx_malformed");
    await expectCode(readXlsx(book({ sheets: [{ name: "S", rows: `<row><c t="inlineStr"><is><t>&#xD800;</t></is></c></row>` }] })), "xlsx_malformed");
  });

  it("handles comments, processing instructions, prefixes and single-quoted attributes", async () => {
    const xml = `<?xml version='1.0'?><!-- c --><x:worksheet xmlns:x='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><?pi data?><x:sheetData><x:row r='1'><!-- <c r="Z1"><v>9</v></c> --><x:c r='B1' t='inlineStr'><x:is><x:t>p&#39;q</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`;
    const rows = await firstSheet({ override: { "xl/worksheets/sheet1.xml": { data: xml } } });
    expect(rows).toEqual([[E, str("p'q")]]);
  });

  it("reports encrypted entries", async () => {
    await expectCode(readXlsx(book({ override: { "xl/workbook.xml": { flags: 0x0001 } } })), "xlsx_encrypted");
  });

  it("reports unsupported compression methods", async () => {
    await expectCode(readXlsx(book({ override: { "xl/workbook.xml": { method: 0, declaredMethod: 12 } } })), "xlsx_unsupported_compression");
  });

  it("enforces maxEntries", async () => {
    await expectCode(readXlsx(book(), { maxEntries: 2 }), "xlsx_too_large");
  });

  it("never throws non-XlsxError for random garbage after a zip magic", async () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    const base = book();
    for (let trial = 0; trial < 200; trial++) {
      const bytes = base.slice();
      for (let k = 0; k < 8; k++) bytes[4 + (rand() * 977 + rand()) % (bytes.length - 4)] = rand();
      try {
        await readXlsx(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(XlsxError);
      }
    }
  });
});

describe("looksLikeXlsx", () => {
  it("requires a zip with xl/workbook.xml in the central directory", () => {
    expect(looksLikeXlsx(book())).toBe(true);
    expect(looksLikeXlsx(zip([{ name: "word/document.xml", data: "<w/>" }]))).toBe(false);
    expect(looksLikeXlsx(enc.encode("PK\x03\x04 not really"))).toBe(false);
    expect(looksLikeXlsx(new Uint8Array(0))).toBe(false);
  });
});
