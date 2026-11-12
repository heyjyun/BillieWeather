// Typo- and homophone-tolerant matching of a phrase against a token sequence.

import type { Token } from "./text";

/** Readings of a character (e.g. toneless pinyin). Two characters "sound alike" when they share one. */
export interface PhoneticEncoder {
  readings(char: string): readonly string[];
}

/**
 * A small toneless-pinyin table for characters common in commands and everyday vocabulary.
 * Input-method slips (picking a same-sounding character) are the most frequent Chinese "typo".
 * Antonym pairs that share a syllable (买/卖) are deliberately not listed. Hosts can extend or
 * replace it (e.g. with pinyin-pro) through `EngineOptions.phonetic`.
 */
const PINYIN_GROUPS =
  "an:安按案暗岸 ba:把八吧拔 bai:白百摆败 ban:办半版班般板搬 bao:包报保宝饱 bei:被北备背倍杯 ben:本笨奔 bi:比笔必币闭避 bian:边变编便遍 biao:表标 bie:别 bu:不部步布补 " +
  "cai:才菜财彩采 can:餐参残 ce:测策册侧 cha:查差茶插察 chan:产 chang:场常长唱厂 chao:超朝 che:车撤彻 chu:出除处初储础 chuang:创窗床 ci:次此词 cun:存村 cuo:错 " +
  "da:打大达答 dai:带代贷待袋 dan:单但担蛋 dang:当 dao:到导道倒 de:的得德 deng:等登 di:地第低底 dian:点电店典 ding:定订顶 dong:动东懂 dou:都 du:读度都 duan:段短断 dui:对队 duo:多 " +
  "e:额 er:二而儿 fa:发法 fan:饭反返范翻 fang:方房放 fei:费非飞 fen:分份 fu:付复服副富福 gai:改该盖 gan:干感 gao:高告搞 ge:个各格 gei:给 gen:跟根 geng:更 gong:工公共功 gou:购够 " +
  "gu:股顾 gua:挂 guan:关管馆 gui:归规 guo:过国果 hai:还孩 han:含 hang:行 hao:号好 he:和合 hei:黑 hong:红 hou:后 hu:户护 hua:花话画划华化 huan:换还环 hui:回会恢汇灰 huo:或获 " +
  "ji:记计机及几级际即积 jia:加家价 jian:建件见键间检简减 jiang:将奖 jiao:交教较 jie:结节解界接 jin:今金进近 jing:经 jiu:就旧九 ju:据局 kai:开 kan:看 ke:可课 kong:空 kuai:块快 " +
  "lai:来 lan:蓝 lei:类累泪 li:里理利历 lian:连 liang:两亮量 lie:列 lu:录路 ma:吗马 mai:买 man:满 mei:没每美 men:们门 mian:面免 ming:名明 mo:末 mu:目 na:那哪拿 nei:内 nian:年 " +
  "pai:排 pian:片便 pin:品 qi:其起期气 qian:前钱 qie:切且 qing:请清 qu:去取区趣 quan:全权 ri:日 ru:入如 san:三 shan:删山闪 shang:上商 shao:少 she:设社 shen:什深 sheng:生 " +
  "shi:是事时示式试市实十使 shou:收手首 shu:数书输属 shuang:双 shui:税水 sou:搜 suo:所索 ta:他她它 tai:台太 ti:提题体 tian:天添 tiao:条调 ting:停 tong:统同通 tou:头 tu:图 tui:退 " +
  "wai:外 wan:完万 wang:网往 wei:为位 wen:文问 wo:我 wu:物务误五 xi:系细 xia:下 xian:显现线先限 xiang:项想向 xiao:消销小 xie:写些 xin:新信心 xing:行型 xu:需 xuan:选 yan:言 " +
  "ye:页也业 yi:一以已易 yin:饮引银印 ying:应 yong:用 you:有又 yu:语于与余预 yuan:元原 yue:月越约 zai:在再 zao:早 ze:则 zen:怎 zhang:账张帐长 zhao:找照 zhe:这 zhen:真 " +
  "zheng:正 zhi:支只至置知直值 zhong:中种 zhou:周 zhu:主住注 zhuan:转专 zi:自字资 zong:总 zou:走 zui:最 zuo:昨作做";

export function tableEncoder(groups: string): PhoneticEncoder {
  const table = new Map<string, string[]>();
  for (const group of groups.trim().split(/\s+/)) {
    const [reading, chars] = group.split(":");
    for (const char of Array.from(chars)) table.set(char, [...(table.get(char) ?? []), reading]);
  }
  return { readings: (char) => table.get(char) ?? [] };
}

export const defaultPhonetic: PhoneticEncoder = tableEncoder(PINYIN_GROUPS);

/** Optimal string alignment distance (Levenshtein with adjacent transpositions). */
export function editDistance(a: string, b: string, limit = Infinity): number {
  if (a === b) return 0;
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) value = Math.min(value, prev2[j - 2] + 1);
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[y.length];
}

/** Edits tolerated for a word of this length: short words must be exact (or one transposition). */
export function allowedEdits(length: number): number {
  if (length <= 2) return 0;
  if (length <= 5) return 1;
  return 2;
}

export interface MatchOptions {
  phonetic: PhoneticEncoder;
  /** The last pattern word may be the beginning of a text word (autocomplete: "op" → "open"). */
  prefixLast?: boolean;
}

export type TokenMatchKind = "exact" | "typo" | "homophone" | "prefix";

/** Cost (0 = identical, 1 = unrelated) of reading text token `t` as pattern token `p`. */
export function tokenCost(p: Token, t: Token, options: MatchOptions, isLastPattern = false): { cost: number; kind: TokenMatchKind | null } {
  if (p.text === t.text) return { cost: 0, kind: "exact" };
  if (p.kind === "word" && t.kind === "word") {
    if (options.prefixLast && isLastPattern && t.text.startsWith(p.text)) return { cost: 0.05, kind: "prefix" };
    const length = Math.max(Array.from(p.text).length, Array.from(t.text).length);
    const allowed = allowedEdits(Array.from(p.text).length);
    const distance = editDistance(p.text, t.text, Math.max(allowed, 1));
    if (distance <= allowed) return { cost: Math.min(0.5, (distance / length) * 1.2), kind: "typo" };
    // Three-letter words: one adjacent transposition only ("teh" → "the").
    if (allowed === 0 && length === 3 && distance === 1 && [...p.text].sort().join("") === [...t.text].sort().join("")) return { cost: 0.4, kind: "typo" };
    return { cost: 1, kind: null };
  }
  if (p.kind === "han" && t.kind === "han") {
    const readings = options.phonetic.readings(p.text);
    if (readings.length && options.phonetic.readings(t.text).some((r) => readings.includes(r))) return { cost: 0.3, kind: "homophone" };
  }
  return { cost: 1, kind: null };
}

export interface PhraseMatch {
  /** 0..1, 1 = exact contiguous match. */
  quality: number;
  /** Indices (into the text token list) of tokens aligned to pattern tokens. */
  matched: number[];
  /** First and last text token index covered (inclusive). */
  first: number;
  last: number;
  corrections: Array<{ from: string; to: string; kind: TokenMatchKind }>;
}

const GAP_COST = 0.35;

/**
 * Semi-global alignment: every pattern token must be accounted for, the text may contain anything
 * before and after, and a few unrelated text tokens may sit between pattern tokens ("change the
 * the name" still matches "change name"). Returns the best match or null.
 */
export function matchPhrase(pattern: readonly Token[], text: readonly Token[], options: MatchOptions, available?: (index: number) => boolean): PhraseMatch | null {
  const m = pattern.length;
  const n = text.length;
  if (m === 0 || n === 0) return null;
  const usable = (j: number) => !available || available(j);
  // cost[i][j]: best cost of aligning pattern[0..i) with the text ending at token j (exclusive).
  const cost: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const move: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0)); // 1 match, 2 skip pattern, 3 gap
  for (let j = 0; j <= n; j++) cost[0][j] = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      let best = cost[i - 1][j] + 1;
      let how = 2;
      if (j > 0) {
        if (usable(j - 1)) {
          const sub = cost[i - 1][j - 1] + tokenCost(pattern[i - 1], text[j - 1], options, i === m).cost;
          if (sub < best) { best = sub; how = 1; }
        }
        const gap = cost[i][j - 1] + (usable(j - 1) ? GAP_COST : 1);
        if (gap < best) { best = gap; how = 3; }
      }
      cost[i][j] = best;
      move[i][j] = how;
    }
  }
  let end = -1;
  let total = Infinity;
  for (let j = 1; j <= n; j++) if (cost[m][j] < total) { total = cost[m][j]; end = j; }
  if (end < 0) return null;
  const matched: number[] = [];
  const corrections: PhraseMatch["corrections"] = [];
  let i = m;
  let j = end;
  while (i > 0 && j >= 0) {
    const how = move[i][j];
    if (how === 1) {
      const result = tokenCost(pattern[i - 1], text[j - 1], options, i === m);
      if (result.cost >= 1) { i -= 1; j -= 1; continue; } // a substitution that did not really match
      matched.unshift(j - 1);
      if (result.kind && result.kind !== "exact") corrections.unshift({ from: text[j - 1].text, to: pattern[i - 1].text, kind: result.kind });
      i -= 1; j -= 1;
    } else if (how === 2) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  if (matched.length === 0) return null;
  const quality = Math.max(0, 1 - total / m);
  return { quality, matched, first: matched[0], last: matched[matched.length - 1], corrections };
}
