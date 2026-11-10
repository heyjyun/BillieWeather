/**
 * OFX / QFX bank-statement parser (OFX 1.x SGML and OFX 2.x XML).
 *
 * Pure TypeScript, no dependencies, no I/O. The caller decodes bytes to text
 * (see `encodingHint`) and hands the string in.
 *
 * Design rules (financial correctness first):
 * - Amounts are returned as the raw trimmed text from the file. They are never
 *   run through `Number` — the caller converts with its own decimal logic.
 * - Dates keep only the literal YYYYMMDD part of an OFX datetime. The timezone
 *   bracket (e.g. `[-5:EST]`) is deliberately NOT applied: banks put the
 *   booking date in the date part, and shifting by the offset would move
 *   midnight-stamped transactions to the previous/next day. Invalid or
 *   out-of-range (outside 1900-2100) dates become `null`; nothing is guessed.
 * - Records are never dropped silently: a STMTTRN without TRNAMT is returned
 *   with `amount: ""` so the caller can flag it for review.
 * - Privacy: only the last 4 alphanumerics of ACCTID are returned (and only
 *   when the ID is longer than 4, otherwise `null`). Error details only ever
 *   contain tag names and line numbers, never values.
 *
 * Structure / tolerance rules (shared by SGML and XML modes):
 * - Tag names are case-insensitive. A leaf's value is the text up to the next
 *   tag, trimmed; an explicit `</LEAF>` right after the value is consumed, but
 *   is optional (SGML style).
 * - Aggregates must be closed explicitly. An element that is implicitly closed
 *   (by a close tag of an ancestor) is accepted only when it is an empty
 *   element or an unknown, value-less element (its children are then re-parented,
 *   SGML empty-leaf style). A known aggregate (STMTTRN, STMTRS, BANKTRANLIST, ...)
 *   that has content but is never closed is `ofx_malformed`. In particular a
 *   missing `</STMTTRN>` before the next `<STMTTRN>` is NOT tolerated: the OFX
 *   DTD requires the end tag for aggregates, and guessing boundaries could merge
 *   or split money records.
 * - Truncated input (the `<OFX>` root never closed), stray close tags, stray
 *   text inside an aggregate, broken tags or unterminated comments are
 *   `ofx_malformed`. Partial results are never returned.
 * - Comments, processing instructions and DOCTYPE/ENTITY declarations are
 *   skipped; declared entities are never expanded. Only the predefined
 *   entities (&amp; &lt; &gt; &quot; &apos; &nbsp;) and numeric references are
 *   decoded; anything else is left verbatim (e.g. raw `AT&T` in SGML).
 * - Content after the closing `</OFX>` is ignored.
 * - `maxBytes` is measured in string length (UTF-16 code units) of the text.
 */

export type OfxErrorCode = "ofx_not_ofx" | "ofx_malformed" | "ofx_no_statements" | "ofx_too_large";

export class OfxError extends Error {
  constructor(public code: OfxErrorCode, public detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OfxError";
  }
}

export interface OfxBalance { amount: string; asOf: string | null }

export interface OfxTransaction {
  index: number;
  trnType: string;
  posted: string | null;
  userDate: string | null;
  amount: string;
  fitId: string | null;
  name: string | null;
  memo: string | null;
  payee: string | null;
  checkNum: string | null;
  refNum: string | null;
  sic: string | null;
  currency: string | null;
  currencyRate: string | null;
  originalCurrency: boolean;
  correctAction: string | null;
  correctFitId: string | null;
  sourceLine: number;
}

export interface OfxStatement {
  kind: "bank" | "creditcard";
  currency: string | null;
  bankId: string | null;
  branchId: string | null;
  accountLast4: string | null;
  accountType: string | null;
  start: string | null;
  end: string | null;
  ledgerBalance: OfxBalance | null;
  availableBalance: OfxBalance | null;
  transactions: OfxTransaction[];
}

export interface OfxDocument {
  version: "sgml" | "xml";
  institution: { org: string | null; fid: string | null };
  statements: OfxStatement[];
  encodingHint: string | null;
}

export interface OfxParseOptions { maxBytes?: number; maxTransactions?: number }

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TRANSACTIONS = 50_000;
const MAX_DEPTH = 100;
const SNIFF_LENGTH = 4096;

export function looksLikeOfx(text: string): boolean {
  if (typeof text !== "string") return false;
  const head = text.slice(0, SNIFF_LENGTH);
  return /OFXHEADER\s*:/i.test(head) || /<\?OFX[\s?]/i.test(head) || /<OFX\s*>/i.test(head);
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { t: "open"; name: string; selfClose: boolean; line: number }
  | { t: "close"; name: string; line: number }
  | { t: "text"; value: string; line: number };

const NAME_RE = /[A-Za-z_][A-Za-z0-9_.:-]*/y;

const malformed = (detail: string): never => { throw new OfxError("ofx_malformed", detail); };

class Lexer {
  private i = 0;
  private lineNo = 1;
  sawXmlDecl = false;
  sawOfxPi = false;
  xmlEncoding: string | null = null;

  constructor(private readonly s: string) {}

  /** Moves the cursor to `to`, counting LF, CRLF and lone CR as line breaks. */
  private advance(to: number): void {
    const s = this.s;
    for (let k = this.i; k < to; k++) {
      const c = s.charCodeAt(k);
      if (c === 10 || (c === 13 && s.charCodeAt(k + 1) !== 10)) this.lineNo++;
    }
    this.i = to;
  }

  next(): Token | null {
    const s = this.s;
    for (;;) {
      if (this.i >= s.length) return null;
      const start = this.i;
      const line = this.lineNo;
      if (s.charCodeAt(start) !== 60 /* < */) {
        let end = s.indexOf("<", start);
        if (end < 0) end = s.length;
        const raw = s.slice(start, end);
        this.advance(end);
        return { t: "text", value: decodeEntities(raw), line };
      }
      if (s.startsWith("<!--", start)) {
        const end = s.indexOf("-->", start + 4);
        if (end < 0) malformed(`unterminated comment at line ${line}`);
        this.advance(end + 3);
        continue;
      }
      if (s.slice(start, start + 9).toUpperCase() === "<![CDATA[") {
        const end = s.indexOf("]]>", start + 9);
        if (end < 0) malformed(`unterminated CDATA at line ${line}`);
        const value = s.slice(start + 9, end);
        this.advance(end + 3);
        return { t: "text", value, line };
      }
      if (s.charCodeAt(start + 1) === 33 /* ! */) {
        // DOCTYPE / ENTITY / other declaration: skipped, never expanded.
        let depth = 0;
        let quote = 0;
        let k = start + 2;
        for (; k < s.length; k++) {
          const c = s.charCodeAt(k);
          if (quote) { if (c === quote) quote = 0; continue; }
          if (c === 34 || c === 39) quote = c;
          else if (c === 91 /* [ */) depth++;
          else if (c === 93 /* ] */) depth = Math.max(0, depth - 1);
          else if (c === 62 /* > */ && depth === 0) break;
        }
        if (k >= s.length) malformed(`unterminated declaration at line ${line}`);
        this.advance(k + 1);
        continue;
      }
      if (s.charCodeAt(start + 1) === 63 /* ? */) {
        const end = s.indexOf("?>", start + 2);
        if (end < 0) malformed(`unterminated processing instruction at line ${line}`);
        const body = s.slice(start + 2, end);
        if (/^xml\b/i.test(body)) {
          this.sawXmlDecl = true;
          const enc = /encoding\s*=\s*["']([^"']{1,40})["']/i.exec(body);
          if (enc) this.xmlEncoding = enc[1]!.trim();
        } else if (/^OFX\b/i.test(body)) {
          this.sawOfxPi = true;
        }
        this.advance(end + 2);
        continue;
      }
      // Element tag.
      let k = start + 1;
      const close = s.charCodeAt(k) === 47; /* / */
      if (close) k++;
      NAME_RE.lastIndex = k;
      const m = NAME_RE.exec(s);
      if (!m) malformed(`invalid tag at line ${line}`);
      const name = m![0].toUpperCase();
      k += m![0].length;
      let gt = k;
      for (; gt < s.length; gt++) {
        const c = s.charCodeAt(gt);
        if (c === 62) break;
        if (c === 60) malformed(`unterminated tag <${name}> at line ${line}`);
      }
      if (gt >= s.length) malformed(`unterminated tag <${name}> at line ${line}`);
      const selfClose = !close && s.charCodeAt(gt - 1) === 47;
      this.advance(gt + 1);
      return close ? { t: "close", name, line } : { t: "open", name, selfClose, line };
    }
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(raw: string): string {
  if (raw.indexOf("&") < 0) return raw;
  return raw.replace(/&(#[0-9]{1,8}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z]{2,6});/g, (whole, ref: string) => {
    if (ref.charCodeAt(0) === 35 /* # */) {
      const cp = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

// ---------------------------------------------------------------- tree

interface OfxNode { name: string; line: number; value: string | null; children: OfxNode[] }

/** Aggregates the parser relies on; these must be closed explicitly when they have content. */
const KNOWN_AGGREGATES = new Set([
  "OFX", "SIGNONMSGSRSV1", "SONRS", "STATUS", "FI", "BANKMSGSRSV1", "STMTTRNRS", "STMTRS", "BANKACCTFROM",
  "BANKACCTTO", "BANKTRANLIST", "STMTTRN", "LEDGERBAL", "AVAILBAL", "BALLIST", "BAL", "CREDITCARDMSGSRSV1",
  "CCSTMTTRNRS", "CCSTMTRS", "CCACCTFROM", "CCACCTTO", "PAYEE", "CURRENCY", "ORIGCURRENCY",
]);

/** Elements that can never contain children; an empty one is closed by the next tag (SGML). */
const KNOWN_LEAVES = new Set([
  "TRNTYPE", "DTPOSTED", "DTUSER", "DTAVAIL", "TRNAMT", "FITID", "CORRECTFITID", "CORRECTACTION", "SRVRTID",
  "CHECKNUM", "REFNUM", "SIC", "PAYEEID", "NAME", "EXTDNAME", "MEMO", "CURSYM", "CURRATE", "CURDEF", "BANKID",
  "BRANCHID", "ACCTID", "ACCTTYPE", "ACCTKEY", "DTSTART", "DTEND", "BALAMT", "DTASOF", "ORG", "FID", "CODE",
  "SEVERITY", "MESSAGE", "DTSERVER", "LANGUAGE", "TRNUID", "INTU.BID", "INTU.USERID",
]);

interface BuildResult { root: OfxNode | null; lexer: Lexer; preRootText: string }

function buildTree(text: string): BuildResult {
  const lexer = new Lexer(text);
  let preRootText = "";
  let root: OfxNode | null = null;
  let tok: Token | null;

  while ((tok = lexer.next())) {
    if (tok.t === "text") preRootText += tok.value;
    else if (tok.t === "open" && tok.name === "OFX") {
      root = { name: "OFX", line: tok.line, value: tok.selfClose ? "" : null, children: [] };
      if (tok.selfClose) return { root, lexer, preRootText };
      break;
    }
  }
  if (!root) return { root, lexer, preRootText };

  const stack: OfxNode[] = [root];
  /** True while the top of the stack is a leaf whose value is being read. */
  let inLeaf = false;

  const finishLeaf = () => {
    const leaf = stack.pop()!;
    leaf.value = leaf.value!.trim();
    inLeaf = false;
  };

  /** `node` (top of stack, child of `parent`) is being closed without its own end tag. */
  const implicitClose = (node: OfxNode, parent: OfxNode) => {
    if (node.value !== null || node.children.length === 0) {
      node.value = (node.value ?? "").trim();
      return;
    }
    if (KNOWN_AGGREGATES.has(node.name)) malformed(`<${node.name}> opened at line ${node.line} is never closed`);
    // Unknown value-less element with following siblings: SGML empty leaf; re-parent its "children".
    parent.children.push(...node.children);
    node.children = [];
    node.value = "";
  };

  while (stack.length > 0 && (tok = lexer.next())) {
    const top = stack[stack.length - 1]!;
    if (tok.t === "text") {
      if (inLeaf) { top.value += tok.value; continue; }
      if (tok.value.trim() === "") continue;
      if (top.children.length > 0 || KNOWN_AGGREGATES.has(top.name)) malformed(`unexpected text inside <${top.name}> at line ${tok.line}`);
      top.value = tok.value;
      inLeaf = true;
      continue;
    }

    if (inLeaf) {
      const leafName = top.name;
      finishLeaf();
      if (tok.t === "close" && tok.name === leafName) continue; // explicit </LEAF>
    } else if (tok.t === "open" && KNOWN_LEAVES.has(top.name) && top.children.length === 0) {
      // Empty SGML leaf such as `<MEMO>` directly followed by the next tag.
      stack.pop();
      top.value = "";
    }

    if (tok.t === "open") {
      const parent = stack[stack.length - 1];
      if (!parent) break; // root closed implicitly (only possible for odd input); stop.
      if (stack.length >= MAX_DEPTH) malformed(`nesting deeper than ${MAX_DEPTH} at line ${tok.line}`);
      const node: OfxNode = { name: tok.name, line: tok.line, value: tok.selfClose ? "" : null, children: [] };
      parent.children.push(node);
      if (!tok.selfClose) stack.push(node);
      continue;
    }

    // Close tag.
    let idx = -1;
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]!.name === tok.name) { idx = k; break; }
    if (idx < 0) malformed(`unexpected </${tok.name}> at line ${tok.line}`);
    while (stack.length - 1 > idx) {
      const node = stack.pop()!;
      implicitClose(node, stack[stack.length - 1]!);
    }
    const closed = stack.pop()!;
    if (closed.value === null && closed.children.length === 0) closed.value = "";
  }

  if (stack.length > 0) {
    const open = stack.find((n, k) => k > 0 && KNOWN_AGGREGATES.has(n.name)) ?? stack[0]!;
    malformed(`input ends before <${open.name}> opened at line ${open.line} is closed`);
  }
  return { root, lexer, preRootText };
}

// ---------------------------------------------------------------- extraction

const child = (node: OfxNode | null | undefined, name: string): OfxNode | null =>
  node?.children.find((c) => c.name === name) ?? null;

/** Trimmed leaf text, `null` when absent, empty, or an aggregate. */
function leaf(node: OfxNode | null | undefined, name: string): string | null {
  const c = child(node, name);
  if (!c || c.children.length > 0) return null;
  const v = (c.value ?? "").trim();
  return v === "" ? null : v;
}

const collapse = (v: string | null): string | null => {
  if (v === null) return null;
  const out = v.replace(/\s+/g, " ").trim();
  return out === "" ? null : out;
};

const upper = (v: string | null): string | null => (v === null ? null : v.toUpperCase());

/** Every node named in `names`, document order, not descending into matches. */
function findAll(node: OfxNode, names: Set<string>, out: OfxNode[] = []): OfxNode[] {
  for (const c of node.children) {
    if (names.has(c.name)) out.push(c);
    else findAll(c, names, out);
  }
  return out;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/**
 * OFX datetime `YYYYMMDD[HHMMSS[.XXX]][[+-]h[:tz]]` -> `YYYY-MM-DD`.
 * Only the literal date part is used; the timezone offset is intentionally not
 * applied (see the module comment). Anything that is not a real calendar date
 * between 1900 and 2100 yields null.
 */
function ofxDate(raw: string | null): string | null {
  if (raw === null) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:\d{2}(?:\d{2}(?:\d{2}(?:\.\d{1,6})?)?)?)?\s*(?:\[[^\]]*\])?$/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function last4(acctId: string | null): string | null {
  if (acctId === null) return null;
  const alnum = acctId.replace(/[^A-Za-z0-9]/g, "");
  // An ID of 4 or fewer characters would be fully exposed by "last 4"; omit it.
  return alnum.length > 4 ? alnum.slice(-4) : null;
}

function balance(node: OfxNode | null): OfxBalance | null {
  if (!node) return null;
  return { amount: leaf(node, "BALAMT") ?? "", asOf: ofxDate(leaf(node, "DTASOF")) };
}

function transaction(node: OfxNode, index: number): OfxTransaction {
  const cur = child(node, "CURRENCY");
  const orig = cur ? null : child(node, "ORIGCURRENCY");
  const curNode = cur ?? orig;
  const payeeNode = child(node, "PAYEE");
  const payee = payeeNode && payeeNode.children.length > 0 ? leaf(payeeNode, "NAME") : leaf(node, "PAYEE");
  return {
    index,
    trnType: (leaf(node, "TRNTYPE") ?? "").toUpperCase(),
    posted: ofxDate(leaf(node, "DTPOSTED")),
    userDate: ofxDate(leaf(node, "DTUSER")),
    amount: leaf(node, "TRNAMT") ?? "",
    fitId: leaf(node, "FITID"),
    name: collapse(leaf(node, "NAME")),
    memo: collapse(leaf(node, "MEMO")),
    payee: collapse(payee),
    checkNum: leaf(node, "CHECKNUM"),
    refNum: leaf(node, "REFNUM"),
    sic: leaf(node, "SIC"),
    currency: upper(leaf(curNode, "CURSYM")),
    currencyRate: leaf(curNode, "CURRATE"),
    originalCurrency: orig !== null,
    correctAction: upper(leaf(node, "CORRECTACTION")),
    correctFitId: leaf(node, "CORRECTFITID"),
    sourceLine: node.line,
  };
}

function encodingHint(header: Map<string, string>, xmlEncoding: string | null): string | null {
  const enc = header.get("ENCODING") ?? null;
  const charset = header.get("CHARSET") ?? null;
  if (enc && /^UTF-?8$/i.test(enc)) return enc;
  if (charset && charset.toUpperCase() !== "NONE") return charset;
  return enc ?? xmlEncoding;
}

export function parseOfx(text: string, options: OfxParseOptions = {}): OfxDocument {
  try {
    return parseOfxUnsafe(text, options);
  } catch (e) {
    if (e instanceof OfxError) throw e;
    throw new OfxError("ofx_malformed", "unexpected parser failure");
  }
}

function parseOfxUnsafe(input: string, options: OfxParseOptions): OfxDocument {
  if (typeof input !== "string") throw new OfxError("ofx_not_ofx");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxTransactions = options.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
  if (input.length > maxBytes) throw new OfxError("ofx_too_large", `input exceeds ${maxBytes} characters`);
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (!looksLikeOfx(text)) throw new OfxError("ofx_not_ofx");

  const { root, lexer, preRootText } = buildTree(text);
  if (!root) malformed("no <OFX> root element");

  const header = new Map<string, string>();
  for (const m of preRootText.matchAll(/^[ \t]*([A-Za-z]+)[ \t]*:[ \t]*([^\r\n]*?)[ \t]*$/gm)) {
    const key = m[1]!.toUpperCase();
    if (!header.has(key)) header.set(key, m[2]!);
  }
  const isSgmlHeader = header.has("OFXHEADER") && /SGML/i.test(header.get("DATA") ?? "");
  const version: "sgml" | "xml" = !isSgmlHeader && (lexer.sawOfxPi || lexer.sawXmlDecl) ? "xml" : "sgml";

  const fi = findAll(root!, new Set(["FI"]))[0] ?? null;
  const stmtNodes = findAll(root!, new Set(["STMTRS", "CCSTMTRS"]));
  if (stmtNodes.length === 0) throw new OfxError("ofx_no_statements");

  let total = 0;
  const statements: OfxStatement[] = stmtNodes.map((s) => {
    const bank = s.name === "STMTRS";
    const acct = child(s, bank ? "BANKACCTFROM" : "CCACCTFROM");
    const list = child(s, "BANKTRANLIST");
    const trnNodes = list ? list.children.filter((c) => c.name === "STMTTRN") : [];
    total += trnNodes.length;
    if (total > maxTransactions) throw new OfxError("ofx_too_large", `more than ${maxTransactions} transactions`);
    return {
      kind: bank ? "bank" : "creditcard",
      currency: upper(leaf(s, "CURDEF")),
      bankId: bank ? leaf(acct, "BANKID") : null,
      branchId: bank ? leaf(acct, "BRANCHID") : null,
      accountLast4: last4(leaf(acct, "ACCTID")),
      accountType: bank ? upper(leaf(acct, "ACCTTYPE")) : "CREDITCARD",
      start: ofxDate(leaf(list, "DTSTART")),
      end: ofxDate(leaf(list, "DTEND")),
      ledgerBalance: balance(child(s, "LEDGERBAL")),
      availableBalance: balance(child(s, "AVAILBAL")),
      transactions: trnNodes.map((n, i) => transaction(n, i)),
    };
  });

  return {
    version,
    institution: { org: collapse(leaf(fi, "ORG")), fid: leaf(fi, "FID") },
    statements,
    encodingHint: encodingHint(header, lexer.xmlEncoding),
  };
}
