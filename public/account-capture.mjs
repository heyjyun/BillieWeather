// Pure extraction used by both clients. Only structured proposals reach a writer.
export const institutions = {
  US: ["Chase", "Capital One", "Bank of America", "Wells Fargo", "Citibank", "U.S. Bank", "Discover", "American Express"],
  CN: ["中国银行", "工商银行", "招商银行", "建设银行", "农业银行", "支付宝", "微信"],
  CA: ["RBC", "TD Bank", "Scotiabank", "BMO"], GB: ["Barclays", "HSBC", "NatWest"],
  JP: ["三菱UFJ銀行", "みずほ銀行"], KR: ["국민은행", "신한은행"], ES: ["Santander", "BBVA"],
};
const bankNames = [...new Set([...Object.values(institutions).flat(), "Alipay", "WeChat", "PayPal", "Venmo", "微信支付"])]
  .sort((a, b) => b.length - a.length);
const types = [
  ["credit_card", /credit card|tarjeta de cr[eé]dito|信用卡|クレジットカード|신용카드/i],
  ["checking", /checking|chequing|cuenta corriente|支票|活期|当座|입출금/i],
  ["savings", /savings?|cuenta de ahorro|储蓄|儲蓄|普通預金|저축/i],
  ["payment_app", /wallet|alipay|wechat|paypal|venmo|billetera|钱包|錢包|微信|支付[宝寶]|ウォレット|지갑/i],
  ["loan", /loan|mortgage|pr[eé]stamo|贷款|貸款|ローン|대출/i],
  ["investment", /investment|brokerage|inversi[oó]n|投资|投資|투자/i],
  ["receivable", /receivable|应收|應收/i], ["cash", /\bcash\b|efectivo|现金|現金|현금/i],
];
const nonCurrent = /credit limit|available(?: credit| balance)?|pending|statement balance|minimum(?: payment)?|额度|額度|信用限度|可用|待入账|账单余额|帳單餘額|l[ií]mite|disponible|利用可能|한도/i;
const currentLabel = /current (?:outstanding |account )?balance|outstanding (?:balance|debt)|amount owed|actual balance|余额|餘額|saldo actual|現在残高|현재 잔액/i;
const codes = /\b(?:USD|CAD|EUR|GBP|AUD|NZD|SGD|HKD|CNY|JPY)\b/gi;
export const isDebt = type => type === "credit_card" || type === "loan";
function hasInstitution(text,name) {
  const lower = text.toLowerCase();
  if (!/^[a-z]/i.test(name)) return lower.includes(name);
  const words = name.toLowerCase().replaceAll(".", "\\.");
  return new RegExp("(?:^|[^a-z])" + words + "(?:$|[^a-z])","i").test(lower);
}
export function institutionIn(text) {
  return bankNames.find(name => hasInstitution(text,name)) || "";
}
function parsePart(text, screenshot) {
  const type = types.find(([, pattern]) => pattern.test(text))?.[0] || "";
  const institution = institutionIn(text) || text.match(/(?:institution|bank name|机构|銀行名)\s*[:：]\s*([^\n,;:：]{1,60})/i)?.[1]?.trim() || "";
  if (!type && !institution) return null;
  const last4 = text.match(/(?:ending(?: in)?|last (?:four|4)|尾号|尾號|[•*x]{2,})\s*[:：]?\s*(\d{4})(?!\d)/i)?.[1] || "";
  const date = text.match(/(?:as of|dated?|截至|日期|fecha|基準日)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || "";
  const candidate = screenshot ? text.split("\n").filter(line => currentLabel.test(line) && !nonCurrent.test(line)).join(" ") : text;
  const stripped = candidate.replace(/(?:ending(?: in)?|last (?:four|4)|尾号|尾號|[•*x]{2,})\s*[:：]?\s*\d{4}/gi, "").replace(/\d{4}-\d{2}-\d{2}/g, "");
  const amounts = [...stripped.matchAll(/(?:([$€£¥￥]|USD|CAD|EUR|GBP|AUD|NZD|SGD|HKD|CNY|JPY)\s*(-?\d[\d,]*(?:\.\d{1,2})?)(?![\d.])|(-?\d[\d,]*(?:\.\d{1,2})?)\s*(元|美元|欧元|USD|CAD|EUR|GBP|CNY|JPY)|(?:balance|owe|余额|餘額|欠款|saldo actual|残高|잔액)\s*[:：]?\s*(-?\d[\d,]*(?:\.\d{1,2})?))/gi)];
  let amount = "";
  if (!nonCurrent.test(candidate) && amounts.length === 1) {
    const raw = (amounts[0][2] || amounts[0][3] || amounts[0][5]).replace(/,$/, "");
    if (/^-?(?:\d{1,3}(?:,\d{3})+|\d{1,12})(?:\.\d{1,2})?$/.test(raw)) amount = raw.replaceAll(",", "");
  }
  const symbols = [...new Set(text.match(codes)?.map(code => code.toUpperCase()) || [])];
  const currency = symbols.length === 1 ? symbols[0] : symbols.length ? "" : /美元/.test(text) ? "USD" : /人民币|人民幣/.test(text) ? "CNY" : /€|欧元/.test(text) ? "EUR" : /£/.test(text) ? "GBP" : "";
  return { institution, type, last4, date, currency, amount };
}
export function proposeAccounts(input, screenshot = false) {
  const text = String(input).slice(0, 12000);
  if (screenshot) {
    const banks = bankNames.filter(name => hasInstitution(text,name)).filter((name,_,all) => !all.some(longer => longer !== name && longer.includes(name)));
    const suffixes = new Set([...text.matchAll(/(?:[•*x]{2,}|ending in|尾号|尾號)\s*(\d{4})/gi)].map(hit => hit[1]));
    // A combined overview could place one account's balance below another account's header.
    if (banks.length > 1 || suffixes.size > 1 || types.filter(([,pattern]) => pattern.test(text)).length > 1) return [];
  }
  const parts = screenshot ? [text] : text.split(/(?:[,，](?!\d)|;|；|\n|\band\b|\by una?\b|以及|还有|還有|、|和)/i);
  const groups = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    if (!groups.length || parsePart(part, false)) groups.push(part);
    else groups[groups.length - 1] += " " + part;
  }
  return groups.map(part => parsePart(part, screenshot)).filter(Boolean).slice(0, 20);
}
