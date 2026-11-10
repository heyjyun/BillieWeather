// Detect -> Extract: which source column feeds which canonical field. Proposals come from
// header names in several languages; a person can correct them and save the result as a
// template for that bank's export. A template only applies to a file whose header row is
// exactly the one it was saved for — if the bank changes its export, the person reconfirms.
import type { AccountKind } from "./schema";
import type { DateOrder } from "./dates";
import type { DecimalSeparator } from "./amount";

export type MappedField =
  | "transactionDate" | "postingDate" | "description" | "description2" | "amount" | "debit" | "credit" | "direction"
  | "currency" | "balance" | "bankReference" | "category" | "account" | "status";

export const MAPPED_FIELDS: readonly MappedField[] = [
  "transactionDate", "postingDate", "description", "description2", "amount", "debit", "credit", "direction", "currency", "balance",
  "bankReference", "category", "account", "status",
];

/** Column index -> field. Unmapped columns are kept in `raw` but not interpreted. */
export type ColumnMapping = Partial<Record<MappedField, number>>;

/**
 * "as_is": positive = money in (the BillieWeather convention).
 * "invert": the file shows money out as positive (common for credit-card exports).
 */
export type AmountSign = "as_is" | "invert";

export interface Conventions {
  dateOrder: DateOrder | null;
  decimal: DecimalSeparator | null;
  amountSign: AmountSign | null;
  currency: string | null;
  accountKind: AccountKind;
  /** OCR only: which Chinese script the page uses, when the engine could not tell. */
  ocrScript?: "zh-Hans" | "zh-Hant" | null;
}

export interface ImportTemplate {
  id: string;
  name: string;
  institution: string | null;
  /** Fingerprint of the normalized header row it was saved for. */
  fingerprint: string;
  headers: string[];
  /** Field -> normalized header name (not index, so reordered exports are still recognized as different). */
  fields: Partial<Record<MappedField, string>>;
  conventions: Conventions;
  createdAt: string;
  updatedAt: string;
}

export function normalizeHeaderText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[_\-/.:：()（）\[\]]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Aliases by field. Order inside a list doesn't matter; the first field that claims a header wins. */
const ALIASES: Array<[MappedField, string[]]> = [
  ["postingDate", ["posting date", "post date", "posted date", "posted", "booking date", "booked on", "value date", "valuta", "valutadatum", "wertstellung",
    "date de valeur", "fecha valor", "记账日期", "記帳日期", "入账日期", "入帳日期", "起息日", "記帳日"]],
  ["transactionDate", ["transaction date", "date", "trans date", "trans. date", "txn date", "date of transaction", "buchungstag", "buchungsdatum", "datum",
    "date opération", "date operation", "fecha", "fecha operación", "fecha operacion", "data", "交易日期", "交易日", "交易时间", "交易時間", "日期", "日付",
    "取引日", "お取引日", "거래일", "거래일자", "거래일시"]],
  ["description", ["description", "transaction description", "details", "transaction details", "memo", "narrative", "particulars", "merchant", "payee",
    "name", "reference text", "verwendungszweck", "buchungstext", "beschreibung", "libellé", "libelle", "concepto", "descripción", "descripcion",
    "摘要", "交易摘要", "交易描述", "描述", "说明", "說明", "商户名称", "商戶名稱", "交易说明", "內容", "内容", "お取引内容", "取引内容", "適用", "적요", "내용", "거래내용"]],
  ["description2", ["counterparty", "counter party", "beneficiary", "payee name", "auftraggeber empfänger", "empfänger", "对方户名", "對方戶名", "对方名称",
    "交易对方", "交易對方", "対方", "相手先", "상대방"]],
  ["amount", ["amount", "transaction amount", "net amount", "value", "betrag", "umsatz", "montant", "importe", "monto", "金额", "金額", "交易金额", "交易金額",
    "发生额", "發生額", "金額 円", "거래금액", "금액"]],
  ["debit", ["debit", "debit amount", "debits", "withdrawal", "withdrawals", "money out", "paid out", "out", "charges", "soll", "débit", "debit eur", "cargo",
    "cargos", "支出", "支出金额", "支出金額", "借方", "借方金额", "借方金額", "取出", "提款", "お引出し", "お支払金額", "出金", "출금", "출금액", "찾으신금액"]],
  ["credit", ["credit", "credit amount", "credits", "deposit", "deposits", "money in", "paid in", "in", "haben", "crédit", "abono", "abonos", "收入",
    "收入金额", "收入金額", "贷方", "贷方金额", "貸方", "貸方金額", "存入", "存款", "お預入れ", "お預り金額", "入金", "입금", "입금액", "맡기신금액"]],
  ["direction", ["type", "transaction type", "debit credit", "credit debit", "dr cr", "cr dr", "收支", "收付", "借贷", "借貸", "收/支", "入出金"]],
  ["currency", ["currency", "currency code", "ccy", "währung", "devise", "moneda", "币种", "幣別", "币别", "貨幣", "通貨", "통화"]],
  ["balance", ["balance", "running balance", "closing balance", "ending balance", "balance after", "account balance", "ledger balance", "current balance",
    "available balance", "saldo", "kontostand", "solde", "余额", "餘額", "账户余额", "帳戶餘額", "残高", "差引残高", "잔액", "거래후잔액"]],
  ["bankReference", ["reference", "transaction id", "transaction reference", "reference number", "ref", "ref no", "fitid", "id", "bank reference",
    "referenz", "référence", "referencia", "流水号", "流水號", "交易流水号", "交易序号", "交易序號", "参考号", "參考號", "凭证号", "憑證號", "取引番号", "거래번호"]],
  ["category", ["category", "kategorie", "catégorie", "categoría", "categoria", "类别", "類別", "分类", "分類", "カテゴリ", "분류"]],
  ["account", ["account", "account number", "account no", "account name", "konto", "compte", "cuenta", "账号", "帳號", "账户", "帳戶", "卡号", "卡號",
    "口座番号", "계좌번호"]],
  ["status", ["status", "state", "transaction status", "状态", "狀態", "ステータス", "상태"]],
];

const ALIAS_INDEX = new Map<string, MappedField>();
for (const [field, names] of ALIASES) for (const name of names) if (!ALIAS_INDEX.has(normalizeHeaderText(name))) ALIAS_INDEX.set(normalizeHeaderText(name), field);

/** Cyrillic/Greek letters that OCR engines return for look-alike Latin letters. */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "к": "k", "м": "m", "т": "t", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h",
  "ο": "o", "α": "a", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "τ": "t", "υ": "u", "ε": "e",
};

/**
 * `tolerant` is used for OCR tables only: look-alike letters are folded and one stray character at
 * either end is ignored ("Dateр" -> "date"). It only proposes a column mapping, which the person
 * sees and can change; it never touches amounts or dates.
 */
export function fieldForHeader(header: string, tolerant = false): MappedField | null {
  const exact = ALIAS_INDEX.get(normalizeHeaderText(header));
  if (exact || !tolerant) return exact ?? null;
  const folded = [...normalizeHeaderText(header)].map((char) => CONFUSABLES[char] ?? char).join("").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const direct = ALIAS_INDEX.get(folded);
  if (direct) return direct;
  const chars = [...folded];
  if (chars.length >= 5) {
    const trimmed = ALIAS_INDEX.get(folded.slice(0, -1)) ?? ALIAS_INDEX.get(folded.slice(1));
    if (trimmed) return trimmed;
  }
  // One misread glyph ("交易日其" for "交易日期"): accept only a unique alias of 4+ characters.
  if (chars.length < 4) return null;
  const near = new Set<MappedField>();
  for (const [alias, field] of ALIAS_INDEX) {
    const target = [...alias];
    if (target.length === chars.length && target.filter((char, index) => char !== chars[index]).length === 1) near.add(field);
  }
  return near.size === 1 ? [...near][0] : null;
}

/** Index of the header row within the first rows (bank exports often start with account details). */
export function detectHeaderRow(rows: readonly string[][], scan = 30, tolerant = false): number | null {
  let best: { index: number; score: number } | null = null;
  rows.slice(0, scan).forEach((cells, index) => {
    const fields = new Set(cells.map((cell) => fieldForHeader(cell, tolerant)).filter((field): field is MappedField => field !== null));
    const dated = fields.has("transactionDate") || fields.has("postingDate");
    const valued = fields.has("amount") || fields.has("debit") || fields.has("credit");
    const score = fields.size + (dated ? 2 : 0) + (valued ? 2 : 0);
    if (dated && valued && fields.size >= 3 && (!best || score > best.score)) best = { index, score };
  });
  return best === null ? null : (best as { index: number }).index;
}

export interface MappingProposal {
  mapping: ColumnMapping;
  /** Headers claimed by more than one column for the same field: the person must choose. */
  conflicts: MappedField[];
}

export function proposeMapping(headers: readonly string[], tolerant = false): MappingProposal {
  const mapping: ColumnMapping = {};
  const conflicts = new Set<MappedField>();
  headers.forEach((header, index) => {
    const field = fieldForHeader(header, tolerant);
    if (!field) return;
    if (mapping[field] !== undefined) {
      // Two "date"-like columns: the second becomes the posting date when that is still free.
      if (field === "transactionDate" && mapping.postingDate === undefined) {
        mapping.postingDate = index;
        return;
      }
      if (field === "description" && mapping.description2 === undefined) {
        mapping.description2 = index;
        return;
      }
      conflicts.add(field);
      return;
    }
    mapping[field] = index;
  });
  // A file with only a posting date uses it as the transaction date.
  if (mapping.transactionDate === undefined && mapping.postingDate !== undefined) {
    mapping.transactionDate = mapping.postingDate;
    delete mapping.postingDate;
  }
  return { mapping, conflicts: [...conflicts] };
}

export type MappingProblem = "missing_date" | "missing_description" | "missing_amount" | "amount_and_debit_credit" | "column_reused" | "column_out_of_range";

export function mappingProblems(mapping: ColumnMapping, width: number): MappingProblem[] {
  const problems: MappingProblem[] = [];
  if (mapping.transactionDate === undefined) problems.push("missing_date");
  if (mapping.description === undefined) problems.push("missing_description");
  const hasAmount = mapping.amount !== undefined;
  const hasPair = mapping.debit !== undefined || mapping.credit !== undefined;
  if (!hasAmount && !hasPair) problems.push("missing_amount");
  if (hasAmount && hasPair) problems.push("amount_and_debit_credit");
  const used = Object.values(mapping).filter((index): index is number => index !== undefined);
  if (used.some((index) => index < 0 || index >= width)) problems.push("column_out_of_range");
  // A posting date may share the transaction-date column only when it was set that way automatically.
  const counted = Object.entries(mapping).filter(([field]) => field !== "postingDate").map(([, index]) => index);
  if (new Set(counted).size !== counted.length) problems.push("column_reused");
  return problems;
}

/** FNV-1a over the normalized headers; enough to tell export layouts apart (not a security hash). */
export function headerFingerprint(headers: readonly string[]): string {
  let hash = 0x811c9dc5;
  const text = headers.map(normalizeHeaderText).join("\u001f");
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${headers.length}:${hash.toString(16).padStart(8, "0")}`;
}

export type TemplateMatch =
  | { status: "matched"; template: ImportTemplate; mapping: ColumnMapping }
  /** A template for this institution exists but the file's columns differ: reconfirm, never apply silently. */
  | { status: "changed"; template: ImportTemplate }
  | { status: "none" };

export function matchTemplate(headers: readonly string[], templates: readonly ImportTemplate[], institution: string | null): TemplateMatch {
  const fingerprint = headerFingerprint(headers);
  const normalized = headers.map(normalizeHeaderText);
  const exact = templates.find((template) => template.fingerprint === fingerprint && template.headers.map(normalizeHeaderText).join("\u001f") === normalized.join("\u001f"));
  if (exact) {
    const mapping: ColumnMapping = {};
    for (const [field, header] of Object.entries(exact.fields) as Array<[MappedField, string]>) {
      const index = normalized.indexOf(header);
      if (index >= 0) mapping[field] = index;
    }
    return { status: "matched", template: exact, mapping };
  }
  const bank = institution?.trim().toLowerCase();
  const sameBank = bank ? templates.find((template) => template.institution?.trim().toLowerCase() === bank) : undefined;
  if (sameBank) return { status: "changed", template: sameBank };
  // Same columns mostly, different layout: likely the same bank's export after a format change.
  const similar = templates.find((template) => {
    const saved = new Set(template.headers.map(normalizeHeaderText));
    const shared = normalized.filter((header) => header !== "" && saved.has(header)).length;
    return shared >= Math.max(3, Math.ceil(saved.size * 0.6));
  });
  return similar ? { status: "changed", template: similar } : { status: "none" };
}

export function templateFrom(input: { id: string; name: string; institution: string | null; headers: string[]; mapping: ColumnMapping; conventions: Conventions; now: string }): ImportTemplate {
  const normalized = input.headers.map(normalizeHeaderText);
  const fields: Partial<Record<MappedField, string>> = {};
  for (const [field, index] of Object.entries(input.mapping) as Array<[MappedField, number]>) fields[field] = normalized[index];
  return {
    id: input.id, name: input.name, institution: input.institution, fingerprint: headerFingerprint(input.headers), headers: input.headers, fields,
    conventions: input.conventions, createdAt: input.now, updatedAt: input.now,
  };
}

export interface PreambleInfo {
  institution: string | null;
  last4: string | null;
  kind: AccountKind;
  currency: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
}

const ACCOUNT_LABEL = /(account(?: number| no\.?)?|acct|card(?: number| no\.?)?|iban|konto(?:nummer)?|compte|cuenta|账号|帳號|账户|帳戶|卡号|卡號|口座番号|계좌번호)\s*[:：#]?\s*(.+)$/i;
const BANK_LABEL = /^(bank|institution|financial institution|bank name|银行|銀行|開戶行|开户行|bankname|kreditinstitut|banque|banco)\s*[:：]\s*(.+)$/i;
const CURRENCY_LABEL = /^(currency|币种|幣別|货币|貨幣|währung|devise|moneda|通貨)\s*[:：]?\s*([A-Za-z]{3})\b/i;
const OPENING_LABEL = /^(opening balance|beginning balance|previous balance|balance brought forward|期初余额|期初餘額|上期余额|anfangssaldo|solde initial|saldo inicial)\s*[:：]?\s*(.+)$/i;
const CLOSING_LABEL = /^(closing balance|ending balance|new balance|balance carried forward|期末余额|期末餘額|本期余额|endsaldo|schlusssaldo|solde final|saldo final)\s*[:：]?\s*(.+)$/i;

/** Account details printed above the header row. Only the last four digits of an account number are kept. */
export function readPreamble(rows: readonly string[][]): PreambleInfo {
  const info: PreambleInfo = { institution: null, last4: null, kind: "unknown", currency: null, openingBalance: null, closingBalance: null };
  for (const cells of rows) {
    const line = cells.map((cell) => cell.trim()).filter(Boolean).join(" ").normalize("NFKC").replace(/^([^:：]+?)\s*[:：]\s*[:：]?\s*/, "$1: ");
    if (!line) continue;
    const bank = BANK_LABEL.exec(line);
    if (bank) info.institution ??= bank[2].trim().slice(0, 80);
    const account = ACCOUNT_LABEL.exec(line);
    if (account && !info.last4) {
      const digits = account[2].replace(/[^0-9A-Za-z]/g, "");
      if (digits.length >= 4) info.last4 = digits.slice(-4);
    }
    const currency = CURRENCY_LABEL.exec(line);
    if (currency) info.currency ??= currency[2].toUpperCase();
    const opening = OPENING_LABEL.exec(line);
    if (opening) info.openingBalance ??= opening[2].trim();
    const closing = CLOSING_LABEL.exec(line);
    if (closing) info.closingBalance ??= closing[2].trim();
    const lower = line.toLowerCase();
    if (info.kind === "unknown") {
      if (/credit card|信用卡|クレジット|신용카드|kreditkarte|carte de crédit|tarjeta de crédito/.test(lower)) info.kind = "credit_card";
      else if (/savings|储蓄|儲蓄|定期|普通預金|저축|sparkonto|épargne|ahorro/.test(lower)) info.kind = "savings";
      else if (/checking|current account|chequing|活期|支票|当座|입출금|girokonto|compte courant|cuenta corriente/.test(lower)) info.kind = "checking";
    }
  }
  return info;
}
