// Input normalization, script handling and tokenization.
//
// Matching never happens on the raw input. `normalize` builds a separate match string
// (NFKC width folding, lower case, Traditional → Simplified Chinese for a bounded table,
// unified punctuation, collapsed whitespace) and keeps an index map back to the original,
// so that any value the person typed (a name, a search phrase) is always returned exactly
// as they wrote it.

/**
 * Traditional → Simplified pairs, two characters per entry. Deliberately bounded: it covers
 * common command, UI and everyday vocabulary, not the whole language. Hosts that need
 * full coverage can pass their own converter (see `EngineOptions.scriptConverter`), for example
 * one backed by opencc-js.
 */
const T2S_PAIRS =
  "這这們们個个與与為为從从後后時时間间週周歲岁嗎吗還还沒没說说話话請请幫帮將将讓让變变換换創创標标籤签統统計计總总額额錢钱貨货幣币輸输檢检尋寻過过濾滤篩筛選选擇择顯显現现實实際际網网絡络連连線线雲云備备復复銷销記记稅税務务審审購购醫医療疗運运業业轉转賬账帳帐餘余報报匯汇導导檔档設设啟启動动關关閉闭開开淺浅項项詳详細细資资訊讯應应該该點点擊击鍵键盤盘視视頁页裝装據据庫库類类別别刪删語语單单飲饮買买賣卖錄录數数題题條条筆笔鐘钟號号碼码戶户張张樣样種种價价費费顏颜調调錯错誤误對对確确認认讀读寫写處处圖图書书車车東东門门發发來来會会學学習习經经濟济長长電电腦脑機机歷历隱隐權权誰谁麼么樂乐氣气專专屬属員员準准態态狀状況况訂订閱阅戲戏遊游衛卫藥药險险儲储貸贷債债證证稱称給给頭头盡尽歸归雜杂層层級级範范圍围區区國国縣县臺台灣湾舊旧夠够歡欢謝谢簡简體体紀纪劃划畫画預预測测趨趋勢势餅饼監监試试驗验鎖锁決决問问軟软載载傳传並并則则規规雙双繼继續续於于裡里邊边兩两萬万億亿幾几塊块隻只結结廳厅飯饭館馆紅红獎奖貼贴戲戏標标當当現现櫃柜鈔钞銀银幫帮薦荐產产係系雖虽為为無无義义亂乱並并蘭兰習习嶺岭聽听觀观覽览帶带廣广聯联繫系爾尔鄉乡壓压兒儿闆板僅仅優优惠惠衝冲擁拥擔担據据賴赖讚赞贊赞撥拨陽阳陰阴雲云電电";

const T2S: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const chars = Array.from(T2S_PAIRS);
  for (let i = 0; i + 1 < chars.length; i += 2) if (chars[i] !== chars[i + 1]) map.set(chars[i], chars[i + 1]);
  return map;
})();

/** Simplified forms that are also ordinary Traditional characters: not evidence of either script. */
const SHARED_FORMS = new Set(Array.from("只台里后余准于划并云范么干几万系板了才面"));
const SIMPLIFIED_ONLY: ReadonlySet<string> = new Set([...T2S.values()].filter((c) => !SHARED_FORMS.has(c) && !T2S.has(c)));
const TRADITIONAL_ONLY: ReadonlySet<string> = new Set([...T2S.keys()]);

export type ScriptConverter = (char: string) => string;
export const toSimplifiedChar: ScriptConverter = (char) => T2S.get(char) ?? char;

const PUNCTUATION: Record<string, string> = {
  "，": ",", "。": ".", "、": ",", "：": ":", "；": ";", "！": "!", "？": "?", "（": "(", "）": ")",
  "“": "\"", "”": "\"", "‘": "'", "’": "'", "「": "\"", "」": "\"", "『": "\"", "』": "\"", "《": "\"", "》": "\"",
  "—": "-", "–": "-", "～": "~", "〜": "~",
};

export interface NormalizedText {
  original: string;
  /** The match string. */
  text: string;
  /** `map[i]` is the index in `original` where `text[i]` came from; `map[text.length] === original.length`. */
  map: number[];
}

export function normalize(input: string, convert: ScriptConverter = toSimplifiedChar): NormalizedText {
  let text = "";
  const map: number[] = [];
  let index = 0;
  for (const char of input) {
    let folded = char.normalize("NFKC").toLowerCase();
    folded = Array.from(folded).map((c) => PUNCTUATION[c] ?? convert(c)).join("");
    // Typographic apostrophes were mapped above; control characters become spaces.
    folded = folded.replace(/[\u0000-\u001f\u007f\s]+/g, " ");
    for (const unit of folded) {
      if (unit === " " && (text === "" || text.endsWith(" "))) continue;
      text += unit;
      for (let k = 0; k < unit.length; k++) map.push(index);
    }
    index += char.length;
  }
  while (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  map.push(input.length);
  return { original: input, text, map };
}

/** The original text behind match-string positions [start, end), trimmed. Never rewritten. */
export function originalSlice(source: NormalizedText, start: number, end: number): string {
  const from = source.map[start] ?? source.original.length;
  const to = end >= source.text.length ? source.original.length : source.map[end];
  return source.original.slice(from, to).trim();
}

export type TokenKind = "word" | "han" | "kana" | "number" | "symbol";

export interface Token {
  text: string;
  kind: TokenKind;
  /** Position in the match string. */
  start: number;
  end: number;
  /** Position in the token list. */
  index: number;
}

const TOKEN = /([a-zÀ-ɏ][a-zÀ-ɏ']*)|(\d+(?:[.,]\d+)*)|([㐀-䶿一-鿿豈-﫿])|([぀-ヿ])|([^\s])/gu;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const kind: TokenKind = match[1] ? "word" : match[2] ? "number" : match[3] ? "han" : match[4] ? "kana" : "symbol";
    const value = kind === "word" ? match[0].replace(/'+$/, "") : match[0];
    tokens.push({ text: value, kind, start: match.index!, end: match.index! + match[0].length, index: tokens.length });
  }
  return tokens;
}

export type LanguageTag = "en" | "zh-Hans" | "zh-Hant" | "zh" | "mixed" | "unknown";

export interface LanguageInfo {
  language: LanguageTag;
  han: number;
  latin: number;
  traditionalSignals: number;
  simplifiedSignals: number;
}

/** Script-based detection. Mixed = at least one Han character and one Latin word of 2+ letters. */
export function detectLanguage(input: string): LanguageInfo {
  let han = 0;
  let traditionalSignals = 0;
  let simplifiedSignals = 0;
  for (const char of input) {
    if (/[㐀-䶿一-鿿豈-﫿]/u.test(char)) {
      han += 1;
      if (TRADITIONAL_ONLY.has(char)) traditionalSignals += 1;
      else if (SIMPLIFIED_ONLY.has(char)) simplifiedSignals += 1;
    }
  }
  const latin = (input.normalize("NFKC").match(/[A-Za-zÀ-ɏ]{2,}/g) ?? []).length;
  let language: LanguageTag;
  if (han > 0) {
    const zh: LanguageTag = traditionalSignals > simplifiedSignals ? "zh-Hant" : simplifiedSignals > 0 ? "zh-Hans" : "zh";
    language = latin > 0 ? "mixed" : zh;
  } else {
    language = latin > 0 ? "en" : "unknown";
  }
  return { language, han, latin, traditionalSignals, simplifiedSignals };
}

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** Parses 0–9999 written with Chinese numerals (一, 十二, 二十五, 一百零五, 两千). Null if not a numeral. */
export function parseChineseNumber(text: string): number | null {
  if (!text || !/^[零〇一二两三四五六七八九十百千]+$/u.test(text)) return null;
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char in CN_DIGITS) current = CN_DIGITS[char];
    else {
      const unit = char === "十" ? 10 : char === "百" ? 100 : 1000;
      total += (current || 1) * unit;
      current = 0;
    }
  }
  return total + current;
}

const EN_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };

/** Digits, English number words or Chinese numerals. */
export function parseLooseNumber(text: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text in EN_NUMBERS) return EN_NUMBERS[text];
  return parseChineseNumber(text);
}
