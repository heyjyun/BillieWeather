// Optional country / region of a statement, chosen by the person on the Import page (never
// detected). It is extra context for the rule-based categorizer only:
// - it is consulted only when every existing rule (learned merchant rules, transfers, income,
//   the built-in lists in categorizer.ts) left a transaction Uncategorized, so it can never
//   change a result those rules produce;
// - it never affects amounts, dates, currency, duplicate detection or balances;
// - no network, no model: plain keyword lists, kept short on purpose.
// A statement from one region can still hold foreign transactions, so each list only names
// merchants and terms that are specific enough to be right wherever they appear.
import type { Category } from "@billie/shared-types";

/** Regions offered on the Import page (ISO 3166-1 alpha-2). Names come from Intl.DisplayNames. */
export const STATEMENT_REGIONS = [
  "US", "CN", "HK", "TW", "MO", "CA", "GB", "IE", "JP", "KR", "SG", "MY", "AU", "NZ", "MX", "IN", "DE", "FR", "ES",
] as const;
export type StatementRegion = (typeof STATEMENT_REGIONS)[number];

/** A stored or chosen value as a known region code, or null for "Not specified" (also for anything unknown). */
export function normalizeRegion(value: unknown): StatementRegion | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return (STATEMENT_REGIONS as readonly string[]).includes(code) ? (code as StatementRegion) : null;
}

// Same Unicode-aware word boundaries as categorizer.ts (Ruby parity).
const WORD_CHAR = "[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]";
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Latin-script terms: whole words only, any letter case. */
function words(...list: string[]): RegExp {
  return new RegExp(`(?<!${WORD_CHAR})(?:${list.map(escape).join("|")})(?!${WORD_CHAR})`, "iu");
}

/** Chinese terms: CJK text has no spaces between words, so these match anywhere in the description. */
function anywhere(...list: string[]): RegExp {
  return new RegExp(`(?:${list.map(escape).join("|")})`, "u");
}

export interface RegionalRules {
  /** Checked first. Only for terms that unambiguously mean money moving between people or own accounts. */
  transfers: readonly RegExp[];
  /** First match wins, like RULES in categorizer.ts. */
  rules: ReadonlyArray<readonly [Category, RegExp]>;
}

// Payment channels (ACH, Alipay, WeChat Pay, UnionPay, Direct Debit, Faster Payment…) say how
// money moved, not what it paid for, so they are deliberately not categories here. The merchant
// text after them still is: "支付宝-滴滴出行" is Transport because of 滴滴, not because of 支付宝.
const REGIONAL_RULES: Partial<Record<StatementRegion, RegionalRules>> = {
  US: {
    // Peer-to-peer apps and card autopay from checking; money to a person or to one's own card.
    transfers: [words("zelle", "venmo", "credit crd autopay", "crd autopay")],
    rules: [
      ["Food & dining", words("chick-fil-a", "five guys", "shake shack", "popeyes", "jersey mike", "in-n-out", "panda express", "sweetgreen", "jack in the box",
        "dairy queen", "arby's", "meijer", "albertsons", "giant eagle", "sprouts farmers", "hy-vee", "winco", "h-e-b")],
      ["Transport", words("sunoco", "speedway", "valero", "circle k", "conoco", "phillips 66", "citgo", "septa", "wmata", "bart", "metra", "nj transit", "caltrain", "lirr")],
      ["Utilities", words("duke energy", "con edison", "coned", "dominion energy", "national grid", "cox comm", "frontier comm", "google fi", "mint mobile")],
      ["Health", words("duane reade", "kaiser permanente", "one medical")],
      ["Shopping", words("dollar general", "dollar tree", "tj maxx", "marshalls", "kohl's", "ross stores")],
    ],
  },
  CN: {
    transfers: [anywhere("转账", "信用卡还款", "还信用卡", "微信红包")],
    rules: [
      ["Food & dining", anywhere("美团外卖", "饿了么", "外卖", "餐饮", "餐厅", "饭店", "咖啡", "星巴克", "瑞幸", "肯德基", "麦当劳", "超市", "盒马", "永辉", "便利店", "奶茶", "喜茶", "蜜雪冰城")],
      ["Food & dining", words("meituan waimai", "ele.me", "luckin")],
      ["Transport", anywhere("滴滴", "地铁", "公交", "12306", "铁路", "高铁", "航空", "加油", "中国石化", "中国石油", "停车", "高速")],
      ["Transport", words("didi chuxing", "sinopec", "petrochina")],
      ["Utilities", anywhere("电费", "水费", "燃气", "话费", "宽带", "中国移动", "中国联通", "中国电信", "国家电网")],
      ["Housing", anywhere("房租", "租金", "物业", "房贷")],
      ["Health", anywhere("药房", "药店", "医院", "诊所", "医保")],
      ["Shopping", anywhere("淘宝", "天猫", "京东", "拼多多", "唯品会")],
      ["Shopping", words("taobao", "tmall", "jd.com", "pinduoduo")],
    ],
  },
  GB: {
    // UK channels (standing order, direct debit, faster payment) often pay rent or bills, so none is a transfer.
    transfers: [],
    rules: [
      ["Housing", words("council tax", "letting agent", "lettings")],
      ["Food & dining", words("tesco", "sainsbury's", "sainsburys", "asda", "morrisons", "waitrose", "ocado", "greggs", "pret a manger", "nando's", "wagamama", "deliveroo", "just eat")],
      ["Transport", words("tfl", "transport for london", "trainline", "national rail", "lner", "avanti west coast", "esso", "texaco", "dvla", "congestion charge", "ulez")],
      ["Utilities", words("british gas", "octopus energy", "edf energy", "ovo energy", "thames water", "severn trent", "virgin media", "vodafone", "giffgaff", "tv licence", "bt broadband")],
      ["Health", words("boots", "superdrug", "nhs", "puregym")],
      ["Shopping", words("argos", "primark", "john lewis", "currys", "b&q", "tk maxx", "marks & spencer", "sports direct", "asos")],
    ],
  },
};

/** The regional rules for a region, or null when the region has none yet (or is not specified). */
export function regionalRules(region: string | null | undefined): RegionalRules | null {
  const code = normalizeRegion(region);
  return code ? REGIONAL_RULES[code] ?? null : null;
}

/** Regions that currently have regional rules (the others are stored, but don't change categories yet). */
export const REGIONS_WITH_RULES = Object.keys(REGIONAL_RULES) as StatementRegion[];

/**
 * The category a region's rules suggest for money going out, or null. Callers only ask after the
 * general rules said Uncategorized; money coming in is never asked (it is Income or a transfer already).
 */
export function regionalCategory(region: string | null | undefined, description: string): Category | null {
  const rules = regionalRules(region);
  if (!rules) return null;
  if (rules.transfers.some((pattern) => pattern.test(description))) return "Transfers";
  return rules.rules.find(([, pattern]) => pattern.test(description))?.[0] ?? null;
}
