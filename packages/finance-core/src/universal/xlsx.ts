// Dependency-free, read-only .xlsx reader.
//
// Security posture (statement files come from untrusted sources):
// - The ZIP is read through the End Of Central Directory + central directory; local headers are only
//   used to locate entry data. Declared sizes are checked up front AND re-enforced while inflating, so a
//   zip bomb is aborted as soon as the output exceeds the limits (or its own declared size).
// - Only the parts needed to read cell values are inflated.
// - The XML tokenizer never resolves external entities; any DOCTYPE/<!ENTITY> is rejected outright.
// - Numbers are returned as the exact <v> text (never round-tripped through a JS Number); date serials are
//   converted with integer (BigInt) arithmetic.
// - Every unexpected failure surfaces as XlsxError("xlsx_malformed"); raw errors never escape readXlsx.

export type XlsxCell =
  | { kind: "empty" }
  | { kind: "string"; text: string }
  | { kind: "number"; text: string }
  | { kind: "date"; iso: string; time: string | null }
  | { kind: "boolean"; value: boolean }
  | { kind: "error"; text: string };

export type XlsxSheetState = "visible" | "hidden" | "veryHidden";

export interface XlsxSheet {
  name: string;
  /** Workbook visibility of the sheet; hidden sheets are still returned, in workbook order. */
  state: XlsxSheetState;
  /** rows[r][c] is spreadsheet row r+1, column c+1. Gaps are {kind:"empty"}; trailing empty rows are trimmed. */
  rows: XlsxCell[][];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

export type XlsxErrorCode =
  | "xlsx_not_zip"
  | "xlsx_legacy_xls"
  | "xlsx_encrypted"
  | "xlsx_too_large"
  | "xlsx_malformed"
  | "xlsx_unsupported_compression"
  | "xlsx_no_sheets";

export class XlsxError extends Error {
  constructor(public code: XlsxErrorCode) {
    super(code);
    this.name = "XlsxError";
  }
}

export interface XlsxLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Cells in the padded (dense) output across the whole workbook; an empty padding row counts as one. */
  maxCells: number;
}

const DEFAULT_LIMITS: XlsxLimits = {
  maxEntries: 2000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxCells: 1_000_000,
};

const EMPTY: XlsxCell = Object.freeze({ kind: "empty" as const });

function fail(code: XlsxErrorCode = "xlsx_malformed"): never {
  throw new XlsxError(code);
}

// ---------------------------------------------------------------------------------------------------------
// ZIP

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

interface ZipArchive {
  bytes: Uint8Array;
  entries: Map<string, ZipEntry>;
  lowerNames: Map<string, ZipEntry>;
  centralOffset: number;
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function u16(b: Uint8Array, o: number): number {
  if (o < 0 || o + 2 > b.length) fail();
  return b[o] | (b[o + 1] << 8);
}

function u32(b: Uint8Array, o: number): number {
  if (o < 0 || o + 4 > b.length) fail();
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function isCfb(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && CFB_MAGIC.every((v, i) => bytes[i] === v);
}

function hasZipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const utf8 = new TextDecoder("utf-8");

function openZip(bytes: Uint8Array, maxEntries: number): ZipArchive {
  if (isCfb(bytes)) fail("xlsx_legacy_xls");
  if (!hasZipMagic(bytes)) fail("xlsx_not_zip");
  if (bytes.length < 22) fail();

  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06 &&
        i + 22 + u16(bytes, i + 20) <= bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail(); // truncated or not really a zip

  // ZIP64 end-of-central-directory locator immediately precedes the EOCD.
  if (eocd >= 20 && u32(bytes, eocd - 20) === 0x07064b50) fail("xlsx_too_large");
  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const diskEntries = u16(bytes, eocd + 8);
  const total = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail("xlsx_too_large");
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== total) fail();
  if (total > maxEntries) fail("xlsx_too_large");
  if (cdOffset + cdSize > eocd) fail();

  const entries = new Map<string, ZipEntry>();
  const lowerNames = new Map<string, ZipEntry>();
  const cdEnd = cdOffset + cdSize;
  let p = cdOffset;
  for (let k = 0; k < total; k++) {
    if (p + 46 > cdEnd || u32(bytes, p) !== 0x02014b50) fail();
    const nameLength = u16(bytes, p + 28);
    const extraLength = u16(bytes, p + 30);
    const commentLength = u16(bytes, p + 32);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > cdEnd) fail();
    const entry: ZipEntry = {
      name: utf8.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      flags: u16(bytes, p + 8),
      method: u16(bytes, p + 10),
      crc: u32(bytes, p + 16),
      compressedSize: u32(bytes, p + 20),
      uncompressedSize: u32(bytes, p + 24),
      localOffset: u32(bytes, p + 42),
    };
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localOffset === 0xffffffff) {
      fail("xlsx_too_large");
    }
    // Duplicate names are ambiguous (different readers pick different copies): refuse.
    if (entries.has(entry.name)) fail();
    entries.set(entry.name, entry);
    const lower = entry.name.toLowerCase();
    if (!lowerNames.has(lower)) lowerNames.set(lower, entry);
    p = next;
  }
  return { bytes, entries, lowerNames, centralOffset: cdOffset };
}

function findEntry(zip: ZipArchive, name: string): ZipEntry | null {
  return zip.entries.get(name) ?? zip.lowerNames.get(name.toLowerCase()) ?? null;
}

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

/** Input is fed in small slices so a single write can never expand into an unbounded amount of output. */
const INFLATE_INPUT_SLICE = 16 * 1024;

async function inflateRaw(data: Uint8Array, declaredSize: number, hardLimit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") fail("xlsx_unsupported_compression");
  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream("deflate-raw");
  } catch {
    fail("xlsx_unsupported_compression");
  }
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let stopped = false;
  const pump = (async () => {
    for (let off = 0; off < data.length && !stopped; off += INFLATE_INPUT_SLICE) {
      await writer.ready;
      if (stopped) return;
      await writer.write(data.slice(off, off + INFLATE_INPUT_SLICE));
    }
    if (!stopped) await writer.close();
  })();
  pump.catch(() => undefined); // errors surface through the reader

  const chunks: Uint8Array[] = [];
  let produced = 0;
  const stop = (code: XlsxErrorCode): never => {
    stopped = true;
    reader.cancel().catch(() => undefined);
    writer.abort().catch(() => undefined);
    fail(code);
  };
  for (;;) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      stopped = true;
      fail();
    }
    if (result.done) break;
    produced += result.value.length;
    if (produced > hardLimit) stop("xlsx_too_large");
    if (produced > declaredSize) stop("xlsx_malformed");
    chunks.push(result.value);
  }
  try {
    await pump;
  } catch {
    fail();
  }
  const out = new Uint8Array(produced);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

interface ReadBudget {
  limits: XlsxLimits;
  inflatedTotal: number;
  cells: number;
}

async function readEntry(zip: ZipArchive, entry: ZipEntry, budget: ReadBudget): Promise<Uint8Array> {
  if (entry.flags & 0x0001) fail("xlsx_encrypted");
  if (entry.method !== 0 && entry.method !== 8) fail("xlsx_unsupported_compression");
  const { limits } = budget;
  const remaining = limits.maxTotalBytes - budget.inflatedTotal;
  if (entry.uncompressedSize > limits.maxEntryBytes || entry.uncompressedSize > remaining) fail("xlsx_too_large");

  const { bytes } = zip;
  const local = entry.localOffset;
  if (u32(bytes, local) !== 0x04034b50) fail();
  const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
  const end = start + entry.compressedSize;
  if (end > zip.centralOffset) fail();
  const raw = bytes.subarray(start, end);

  let data: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) fail();
    data = raw;
  } else {
    data = await inflateRaw(raw, entry.uncompressedSize, Math.min(limits.maxEntryBytes, remaining));
  }
  if (data.length !== entry.uncompressedSize) fail();
  if (crc32(data) !== entry.crc) fail();
  budget.inflatedTotal += data.length;
  return data;
}

function decodeXmlBytes(data: Uint8Array): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  return utf8.decode(data); // strips a UTF-8 BOM
}

/** Cheap sniff: ZIP magic plus an "xl/workbook.xml" entry in the central directory. Never throws. */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  try {
    if (!(bytes instanceof Uint8Array) || !hasZipMagic(bytes)) return false;
    return openZip(bytes, Number.MAX_SAFE_INTEGER).entries.has("xl/workbook.xml");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// XML tokenizer (SAX style). Element and attribute names are reported by local name (prefix stripped).

type Attrs = Map<string, string>;

interface XmlHandler {
  open(name: string, attrs: Attrs): void;
  close(name: string): void;
  text(value: string): void;
}

const MAX_XML_DEPTH = 256;

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function localName(qname: string): string {
  const colon = qname.lastIndexOf(":");
  return colon < 0 ? qname : qname.slice(colon + 1);
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decodeEntities(s: string): string {
  let amp = s.indexOf("&");
  if (amp < 0) return s;
  let out = "";
  let last = 0;
  while (amp >= 0) {
    const semi = s.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 12) fail();
    const name = s.slice(amp + 1, semi);
    let replacement: string;
    if (name.charCodeAt(0) === 0x23 /* # */) {
      const hex = name[1] === "x" || name[1] === "X";
      const digits = name.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) fail();
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) fail();
      replacement = String.fromCodePoint(cp);
    } else {
      if (!Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)) fail(); // no DTD, so no other entities
      replacement = NAMED_ENTITIES[name];
    }
    out += s.slice(last, amp) + replacement;
    last = semi + 1;
    amp = s.indexOf("&", last);
  }
  return out + s.slice(last);
}

function parseXml(xml: string, handler: XmlHandler): void {
  const n = xml.length;
  const stack: string[] = [];
  let sawRoot = false;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      if (stack.length > 0) {
        handler.text(decodeEntities(xml.slice(i, textEnd)));
      } else {
        for (let k = i; k < textEnd; k++) if (!isWs(xml.charCodeAt(k))) fail();
      }
    }
    if (lt < 0) break;

    if (xml.startsWith("<!--", lt)) {
      const close = xml.indexOf("-->", lt + 4);
      if (close < 0) fail();
      i = close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      if (stack.length === 0) fail();
      const close = xml.indexOf("]]>", lt + 9);
      if (close < 0) fail();
      handler.text(xml.slice(lt + 9, close));
      i = close + 3;
      continue;
    }
    if (xml.charCodeAt(lt + 1) === 0x21 /* ! */) fail(); // DOCTYPE / ENTITY / anything DTD-ish
    if (xml.charCodeAt(lt + 1) === 0x3f /* ? */) {
      const close = xml.indexOf("?>", lt + 2);
      if (close < 0) fail();
      i = close + 2;
      continue;
    }
    if (xml.charCodeAt(lt + 1) === 0x2f /* / */) {
      const close = xml.indexOf(">", lt + 2);
      if (close < 0) fail();
      const name = xml.slice(lt + 2, close).trim();
      if (stack.length === 0 || stack.pop() !== name) fail();
      handler.close(localName(name));
      i = close + 1;
      continue;
    }

    // Start tag.
    let p = lt + 1;
    while (p < n) {
      const c = xml.charCodeAt(p);
      if (isWs(c) || c === 0x3e || c === 0x2f) break;
      p++;
    }
    const qname = xml.slice(lt + 1, p);
    if (qname.length === 0 || qname.includes("<")) fail();
    const attrs: Attrs = new Map();
    let selfClosing = false;
    for (;;) {
      while (p < n && isWs(xml.charCodeAt(p))) p++;
      if (p >= n) fail();
      const c = xml.charCodeAt(p);
      if (c === 0x3e) {
        p++;
        break;
      }
      if (c === 0x2f) {
        if (xml.charCodeAt(p + 1) !== 0x3e) fail();
        p += 2;
        selfClosing = true;
        break;
      }
      const attrStart = p;
      while (p < n) {
        const a = xml.charCodeAt(p);
        if (isWs(a) || a === 0x3d || a === 0x3e || a === 0x2f || a === 0x3c) break;
        p++;
      }
      const attrName = xml.slice(attrStart, p);
      if (attrName.length === 0) fail();
      while (p < n && isWs(xml.charCodeAt(p))) p++;
      if (xml.charCodeAt(p) !== 0x3d) fail();
      p++;
      while (p < n && isWs(xml.charCodeAt(p))) p++;
      const quote = xml[p];
      if (quote !== "\"" && quote !== "'") fail();
      const valueEnd = xml.indexOf(quote, p + 1);
      if (valueEnd < 0) fail();
      const rawValue = xml.slice(p + 1, valueEnd);
      if (rawValue.includes("<")) fail();
      p = valueEnd + 1;
      // Namespace declarations are not attributes of interest and would collide on local name (xmlns:r vs r).
      if (attrName === "xmlns" || attrName.startsWith("xmlns:")) continue;
      const attrLocal = localName(attrName);
      if (!attrs.has(attrLocal)) attrs.set(attrLocal, decodeEntities(rawValue));
    }
    if (stack.length === 0) {
      if (sawRoot) fail(); // a second root element
      sawRoot = true;
    }
    if (stack.length >= MAX_XML_DEPTH) fail();
    const name = localName(qname);
    handler.open(name, attrs);
    if (selfClosing) handler.close(name);
    else stack.push(qname);
    i = p;
  }
  if (stack.length > 0 || !sawRoot) fail();
}

/** ST_Xstring escapes: "_x000D_" is a carriage return, "_x005F_" a literal underscore. */
function unescapeXstring(s: string): string {
  if (!s.includes("_x")) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ---------------------------------------------------------------------------------------------------------
// Workbook-level parts

interface WorkbookInfo {
  date1904: boolean;
  sheets: Array<{ name: string; rid: string; state: XlsxSheetState }>;
}

function parseWorkbook(xml: string): WorkbookInfo {
  const info: WorkbookInfo = { date1904: false, sheets: [] };
  let inSheets = false;
  parseXml(xml, {
    open(name, attrs) {
      if (name === "workbookPr") {
        const v = attrs.get("date1904");
        info.date1904 = v === "1" || v === "true";
      } else if (name === "sheets") {
        inSheets = true;
      } else if (name === "sheet" && inSheets) {
        const sheetName = attrs.get("name");
        const rid = attrs.get("id");
        if (sheetName === undefined || rid === undefined) fail();
        const rawState = attrs.get("state");
        const state: XlsxSheetState = rawState === "hidden" ? "hidden" : rawState === "veryHidden" ? "veryHidden" : "visible";
        info.sheets.push({ name: sheetName, rid, state });
      }
    },
    close(name) {
      if (name === "sheets") inSheets = false;
    },
    text() {},
  });
  return info;
}

interface Relationship {
  type: string;
  target: string;
  external: boolean;
}

function parseRels(xml: string): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  parseXml(xml, {
    open(name, attrs) {
      if (name !== "Relationship") return;
      const id = attrs.get("Id");
      const target = attrs.get("Target");
      if (id === undefined || target === undefined) fail();
      if (!rels.has(id)) rels.set(id, { type: attrs.get("Type") ?? "", target, external: attrs.get("TargetMode") === "External" });
    },
    close() {},
    text() {},
  });
  return rels;
}

/** Resolves a relationship target from xl/_rels/workbook.xml.rels to a ZIP entry name. */
function resolveTarget(target: string): string {
  const t = target.replace(/\\/g, "/");
  const parts = t.startsWith("/") ? t.slice(1).split("/") : ["xl", ...t.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) fail();
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join("/");
}

function findTarget(zip: ZipArchive, target: string): ZipEntry | null {
  const path = resolveTarget(target);
  const direct = findEntry(zip, path);
  if (direct) return direct;
  try {
    return findEntry(zip, decodeURIComponent(path));
  } catch {
    return null;
  }
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let current: string[] | null = null;
  let phoneticDepth = 0;
  let capture = false;
  parseXml(xml, {
    open(name) {
      if (name === "si") {
        current = [];
        phoneticDepth = 0;
      } else if (name === "rPh") {
        phoneticDepth++;
      } else if (name === "t" && current && phoneticDepth === 0) {
        capture = true;
      }
    },
    close(name) {
      if (name === "t") capture = false;
      else if (name === "rPh") phoneticDepth = Math.max(0, phoneticDepth - 1);
      else if (name === "si" && current) {
        strings.push(unescapeXstring(current.join("")));
        current = null;
      }
    },
    text(value) {
      if (capture && current) current.push(value);
    },
  });
  return strings;
}

// Built-in number formats that are dates/times: 14-22 and 45-47 (all locales), plus the East Asian
// built-ins 27-36 and 50-58 (zh/ja/ko date formats) which are only used by those locales' Excel.
function isBuiltinDateFormat(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58);
}

/** True when a custom number format code renders a date/time. Elapsed-time formats ([h]:mm) are durations, not dates. */
export function isDateFormatCode(code: string): boolean {
  let stripped = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\"") {
      const close = code.indexOf("\"", i + 1);
      i = close < 0 ? code.length : close;
    } else if (ch === "\\" || ch === "_" || ch === "*") {
      i++; // escaped literal, space-width or fill character
    } else if (ch === "[") {
      const close = code.indexOf("]", i + 1);
      const inner = close < 0 ? "" : code.slice(i + 1, close);
      if (/^(h+|m+|s+)$/i.test(inner)) return false;
      i = close < 0 ? code.length : close;
    } else {
      stripped += ch;
    }
  }
  const lower = stripped.toLowerCase().replace(/general/g, "").replace(/am\/pm|a\/p/g, "");
  return /[dmyhs]/.test(lower);
}

function parseStyles(xml: string): boolean[] {
  const customFormats = new Map<number, string>();
  const xfFormatIds: number[] = [];
  let inCellXfs = false;
  parseXml(xml, {
    open(name, attrs) {
      if (name === "numFmt") {
        const id = Number(attrs.get("numFmtId"));
        const code = attrs.get("formatCode");
        if (Number.isInteger(id) && code !== undefined) customFormats.set(id, code);
      } else if (name === "cellXfs") {
        inCellXfs = true;
      } else if (name === "xf" && inCellXfs) {
        const id = Number(attrs.get("numFmtId") ?? "0");
        xfFormatIds.push(Number.isInteger(id) ? id : 0);
      }
    },
    close(name) {
      if (name === "cellXfs") inCellXfs = false;
    },
    text() {},
  });
  return xfFormatIds.map((id) => {
    const code = customFormats.get(id);
    return code !== undefined ? isDateFormatCode(code) : isBuiltinDateFormat(id);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Values

const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_SERIAL_1900 = 2958465n; // 9999-12-31
const MAX_SERIAL_1904 = 2957003n; // 9999-12-31
const INVALID_DATE: XlsxCell = Object.freeze({ kind: "error" as const, text: "#INVALID_DATE" });

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Days since 1970-01-01 → [year, month, day] (proleptic Gregorian, H. Hinnant's algorithm). */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** Converts a serial's exact decimal text to a date. 1900 system keeps Excel's fake 1900-02-29 (serial 60) as invalid. */
function serialToDate(text: string, date1904: boolean): XlsxCell {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return INVALID_DATE;
  const [, sign, intDigits, fracDigits = "", expText = "0"] = m;
  const digits = (intDigits + fracDigits).replace(/^0+/, "") || "0";
  const exponent = Number(expText) - fracDigits.length;
  if (digits.length > 400 || !Number.isFinite(exponent) || exponent > 20 || exponent < -400) {
    return INVALID_DATE;
  }
  const mantissa = BigInt(digits);
  if (sign === "-" && mantissa !== 0n) return INVALID_DATE;
  let day: bigint;
  let seconds: bigint;
  if (exponent >= 0) {
    day = mantissa * 10n ** BigInt(exponent);
    seconds = 0n;
  } else {
    const denom = 10n ** BigInt(-exponent);
    day = mantissa / denom;
    const rem = mantissa % denom;
    seconds = (rem * 86400n * 2n + denom) / (2n * denom); // round half up to the nearest second
    if (seconds === 86400n) {
      day += 1n;
      seconds = 0n;
    }
  }
  let unixDay: number;
  if (date1904) {
    if (day > MAX_SERIAL_1904) return INVALID_DATE;
    unixDay = Number(day) - 24107; // serial 0 = 1904-01-01
  } else {
    if (day < 1n || day === 60n || day > MAX_SERIAL_1900) return INVALID_DATE;
    unixDay = Number(day) - (day < 60n ? 25568 : 25569); // serial 1 = 1900-01-01; 61 = 1900-03-01
  }
  const [y, mo, d] = civilFromDays(unixDay);
  const secs = Number(seconds);
  const time = secs === 0
    ? null
    : `${pad(Math.floor(secs / 3600), 2)}:${pad(Math.floor((secs % 3600) / 60), 2)}:${pad(secs % 60, 2)}`;
  return { kind: "date", iso: `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}`, time };
}

/** t="d" cells (ISO 8601 text, mostly from Strict OOXML writers). */
function isoToDate(text: string): XlsxCell {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(text.trim());
  if (!m) return INVALID_DATE;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const daysInMonth = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth[mo - 1]) return INVALID_DATE;
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return INVALID_DATE;
  const time = h === 0 && mi === 0 && s === 0 ? null : `${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}`;
  return { kind: "date", iso: `${m[1]}-${m[2]}-${m[3]}`, time };
}

interface SheetContext {
  sharedStrings: string[];
  dateStyles: boolean[];
  date1904: boolean;
}

function buildCell(
  type: string, value: string | null, inline: string | null, style: number, ctx: SheetContext,
): XlsxCell | null {
  switch (type) {
    case "s": {
      if (value === null || value.trim() === "") return null;
      const index = value.trim();
      if (!/^\d+$/.test(index)) fail();
      const text = ctx.sharedStrings[Number(index)];
      if (text === undefined) fail();
      return { kind: "string", text };
    }
    case "inlineStr":
      if (inline !== null) return { kind: "string", text: unescapeXstring(inline) };
      return value === null ? null : { kind: "string", text: unescapeXstring(value) };
    case "str":
      return value === null ? null : { kind: "string", text: unescapeXstring(value) };
    case "b": {
      if (value === null) return null;
      const v = value.trim();
      if (v === "1" || v === "true") return { kind: "boolean", value: true };
      if (v === "0" || v === "false") return { kind: "boolean", value: false };
      return fail();
    }
    case "e":
      return value === null ? null : { kind: "error", text: value };
    case "d":
      return value === null || value === "" ? null : isoToDate(value);
    case "n":
    case "": {
      if (value === null || value === "") return null;
      let text = value;
      if (!NUMBER_TEXT.test(text)) {
        text = value.trim();
        if (!NUMBER_TEXT.test(text)) return { kind: "error", text: "#INVALID_NUMBER" };
      }
      if (ctx.dateStyles[style] === true) return serialToDate(text, ctx.date1904);
      return { kind: "number", text };
    }
    default:
      return fail();
  }
}

const MAX_COLUMNS = 16384; // XFD
const MAX_ROWS = 1048576;

function parseCellRef(ref: string): [row: number, col: number] {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) fail();
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  if (col < 1 || col > MAX_COLUMNS || row < 1 || row > MAX_ROWS) fail();
  return [row - 1, col - 1];
}

function parseSheet(xml: string, ctx: SheetContext, budget: ReadBudget): XlsxCell[][] {
  const sparse: Array<XlsxCell[] | undefined> = [];
  let lastRow = -1;
  let maxRow = -1;
  let inSheetData = false;
  let currentRow = 0;
  let colCursor = -1;
  let parsedCells = 0;

  let inCell = false;
  let cellRow = 0;
  let cellCol = 0;
  let cellType = "";
  let cellStyle = 0;
  let value: string | null = null;
  let inline: string | null = null;
  let capture: "v" | "t" | null = null;
  let inInline = false;
  let phoneticDepth = 0;

  parseXml(xml, {
    open(name, attrs) {
      if (name === "sheetData") {
        inSheetData = true;
        return;
      }
      if (!inSheetData) return;
      if (name === "row" && !inCell) {
        const r = attrs.get("r");
        if (r !== undefined) {
          if (!/^\d{1,7}$/.test(r.trim())) fail();
          const n = Number(r.trim());
          if (n < 1 || n > MAX_ROWS) fail();
          currentRow = n - 1;
        } else {
          currentRow = lastRow + 1;
          if (currentRow >= MAX_ROWS) fail();
        }
        lastRow = currentRow;
        colCursor = -1;
      } else if (name === "c" && !inCell) {
        const ref = attrs.get("r");
        if (ref !== undefined) {
          [cellRow, cellCol] = parseCellRef(ref);
        } else {
          cellRow = currentRow;
          cellCol = colCursor + 1;
          if (cellCol >= MAX_COLUMNS) fail();
        }
        colCursor = cellCol;
        cellType = attrs.get("t") ?? "";
        const s = attrs.get("s");
        cellStyle = s !== undefined && /^\d+$/.test(s.trim()) ? Number(s.trim()) : 0;
        value = null;
        inline = null;
        inCell = true;
        inInline = false;
        phoneticDepth = 0;
        if (++parsedCells > budget.limits.maxCells) fail("xlsx_too_large");
      } else if (inCell) {
        if (name === "v" && !inInline) {
          capture = "v";
          value = "";
        } else if (name === "is") {
          inInline = true;
          inline = "";
        } else if (name === "rPh") {
          phoneticDepth++;
        } else if (name === "t" && inInline && phoneticDepth === 0) {
          capture = "t";
        }
      }
    },
    close(name) {
      if (name === "sheetData") {
        inSheetData = false;
        return;
      }
      if (!inCell) return;
      if (name === "v" || name === "t") {
        capture = null;
      } else if (name === "rPh") {
        phoneticDepth = Math.max(0, phoneticDepth - 1);
      } else if (name === "is") {
        inInline = false;
      } else if (name === "c") {
        inCell = false;
        capture = null;
        const cell = buildCell(cellType, value, inline, cellStyle, ctx);
        if (cell !== null) {
          const row = sparse[cellRow] ?? (sparse[cellRow] = []);
          row[cellCol] = cell;
          if (cellRow > maxRow) maxRow = cellRow;
        }
      }
    },
    text(t) {
      if (capture === "v") value += t;
      else if (capture === "t") inline += t;
    },
  });

  const rows: XlsxCell[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const row = sparse[r];
    if (row === undefined) {
      budget.cells += 1;
      if (budget.cells > budget.limits.maxCells) fail("xlsx_too_large");
      rows.push([]);
      continue;
    }
    budget.cells += Math.max(row.length, 1);
    if (budget.cells > budget.limits.maxCells) fail("xlsx_too_large");
    const dense: XlsxCell[] = new Array<XlsxCell>(row.length);
    for (let c = 0; c < row.length; c++) dense[c] = row[c] ?? EMPTY;
    rows.push(dense);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------
// Entry point

function resolveLimits(partial: Partial<XlsxLimits> | undefined): XlsxLimits {
  const limits = { ...DEFAULT_LIMITS };
  if (partial) {
    for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof XlsxLimits>) {
      const v = partial[key];
      if (typeof v === "number" && v >= 0 && !Number.isNaN(v)) limits[key] = v;
    }
  }
  return limits;
}

async function readXlsxUnsafe(bytes: Uint8Array, limits: XlsxLimits): Promise<XlsxWorkbook> {
  if (!(bytes instanceof Uint8Array)) fail("xlsx_not_zip");
  const zip = openZip(bytes, limits.maxEntries);
  for (const entry of zip.entries.values()) if (entry.flags & 0x0001) fail("xlsx_encrypted");
  const budget: ReadBudget = { limits, inflatedTotal: 0, cells: 0 };
  const readXml = async (entry: ZipEntry) => decodeXmlBytes(await readEntry(zip, entry, budget));

  const workbookEntry = findEntry(zip, "xl/workbook.xml");
  const relsEntry = findEntry(zip, "xl/_rels/workbook.xml.rels");
  if (!workbookEntry || !relsEntry) fail();
  const workbook = parseWorkbook(await readXml(workbookEntry));
  const rels = parseRels(await readXml(relsEntry));
  if (workbook.sheets.length === 0) fail("xlsx_no_sheets");

  const partFor = (typeSuffix: string, fallback: string): ZipEntry | null => {
    for (const rel of rels.values()) {
      if (!rel.external && rel.type.endsWith(typeSuffix)) {
        const entry = findTarget(zip, rel.target);
        if (entry) return entry;
      }
    }
    return findEntry(zip, fallback);
  };
  const sharedStringsEntry = partFor("/sharedStrings", "xl/sharedStrings.xml");
  const stylesEntry = partFor("/styles", "xl/styles.xml");
  const ctx: SheetContext = {
    sharedStrings: sharedStringsEntry ? parseSharedStrings(await readXml(sharedStringsEntry)) : [],
    dateStyles: stylesEntry ? parseStyles(await readXml(stylesEntry)) : [],
    date1904: workbook.date1904,
  };

  const sheets: XlsxSheet[] = [];
  for (const sheet of workbook.sheets) {
    const rel = rels.get(sheet.rid);
    if (!rel || rel.external) fail();
    const entry = findTarget(zip, rel.target);
    if (!entry) fail();
    sheets.push({ name: sheet.name, state: sheet.state, rows: parseSheet(await readXml(entry), ctx, budget) });
  }
  return { sheets };
}

/** Reads every sheet of an .xlsx file. Throws only XlsxError. */
export async function readXlsx(bytes: Uint8Array, limits?: Partial<XlsxLimits>): Promise<XlsxWorkbook> {
  try {
    return await readXlsxUnsafe(bytes, resolveLimits(limits));
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError("xlsx_malformed");
  }
}
