// BillieWeather's capabilities, described as data for @nlae/core. Everything finance-specific about
// typed commands lives here and in handlers.ts; the engine itself knows none of these words.

import { ActionRegistry, type ActionDefinition, type EntityCandidate, type EnumOption } from "@nlae/core";
import { CATEGORIES } from "@billie/shared-types";
import { MESSAGES } from "../i18n";
import type { Page } from "../App";

export const PRODUCT = "billieweather-universal";

/** Words that describe transactions in general, never part of a search phrase. */
const TRANSACTION_WORDS = [
  "transactions", "transaction", "payments", "payment", "purchases", "purchase", "charges", "charge", "expenses", "expense", "items", "ones", "records", "entries",
  "交易", "记录", "交易记录", "支出", "消费", "账单", "流水", "款项", "费用", "明细", "的交易", "笔",
];

const PAGES: Array<{ value: Page; aliases: string[] }> = [
  { value: "dashboard", aliases: ["home", "overview", "summary page", "首页", "主页", "仪表盘", "概览", "总览"] },
  { value: "transactions", aliases: ["transaction list", "交易", "交易记录", "流水", "明细"] },
  { value: "categories", aliases: ["category", "category page", "类别", "分类", "类别页"] },
  { value: "import", aliases: ["upload", "imports", "导入", "上传", "导入页"] },
  { value: "reports", aliases: ["report", "export", "exports", "报表", "报告", "导出"] },
  { value: "data", aliases: ["database", "databases", "sync", "数据", "数据库", "同步"] },
  { value: "settings", aliases: ["preferences", "options", "设置", "偏好", "设定"] },
];

export const LANGUAGE_OPTIONS: EnumOption[] = [
  { value: "en", aliases: ["english", "英文", "英语"] },
  { value: "zh-CN", aliases: ["simplified chinese", "chinese", "mandarin", "简体中文", "简体", "中文", "汉语"] },
  { value: "zh-TW", aliases: ["traditional chinese", "繁体中文", "繁体", "正体中文"] },
  { value: "ja", aliases: ["japanese", "日本语", "日语", "日文", "日本語"] },
  { value: "ko", aliases: ["korean", "韩语", "韩文", "한국어"] },
  { value: "es", aliases: ["spanish", "español", "espanol", "西班牙语"] },
];

const THEME_OPTIONS: EnumOption[] = [
  { value: "dark", aliases: ["dark mode", "night", "night mode", "深色", "暗色", "夜间", "深色模式", "暗黑模式", "夜间模式"] },
  { value: "light", aliases: ["light mode", "day mode", "浅色", "亮色", "白色", "浅色模式", "日间模式"] },
  { value: "system", aliases: ["automatic", "auto", "follow system", "系统", "跟随系统", "自动"] },
];

/** Extra names for the built-in categories, on top of their names in every interface language. */
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  Income: ["salary", "paycheck", "wages", "收入", "工资", "薪水", "薪资"],
  Housing: ["rent", "mortgage", "房租", "房贷", "住房", "住宿"],
  "Food & dining": ["food", "dining", "restaurants", "restaurant", "groceries", "eating out", "餐饮", "吃饭", "饮食", "餐厅", "外卖", "美食"],
  Transport: ["transportation", "taxi", "gas", "fuel", "commute", "交通", "出行", "打车", "加油"],
  Utilities: ["bills", "electricity", "internet", "phone bill", "水电", "水电费", "公用事业", "话费", "网费"],
  Shopping: ["retail", "购物", "网购"],
  Health: ["medical", "healthcare", "pharmacy", "doctor", "医疗", "健康", "看病", "药品"],
  Business: ["work expenses", "商务", "业务", "工作开支"],
  Transfers: ["transfer", "转账", "转帐"],
  Uncategorized: ["no category", "unknown", "未分类", "未归类", "无分类"],
};

/** Built-in categories under every translated name; the person's own exactly as typed. */
export function categoryEntities(customCategories: readonly string[], label: (name: string) => string): EntityCandidate[] {
  const builtIn = CATEGORIES.map((name) => {
    const translations = Object.values(MESSAGES).map((m) => (m.categories as Record<string, string>)[name]).filter(Boolean);
    return { id: name, label: label(name), aliases: [...new Set([name, ...translations, ...(CATEGORY_SYNONYMS[name] ?? [])])] };
  });
  return [...builtIn, ...customCategories.map((name) => ({ id: name, label: name }))];
}

const queryParam = { name: "query", type: "text" as const, capture: "remainder" as const, contextKey: "transactionQuery", maxLength: 80, description: "Which transactions (merchant or description)" };
const periodParam = { name: "period", type: "dateRange" as const, contextKey: "transactionPeriod", markers: ["in", "during", "for", "from", "since", "在", "期间"] };
const categoryFilter = { name: "category", type: "entity" as const, entityKind: "category", contextKey: "transactionCategory", markers: ["in", "on", "for", "under", "category", "类别", "分类"] };

export const BILLIE_ACTIONS: ActionDefinition[] = [
  {
    id: "app.navigate", description: "Open a page", risk: "none",
    expressions: ["go to", "open", "navigate to", "take me to", "show page", "switch page", "打开", "进入", "跳转到", "前往", "转到", "去"],
    examples: ["open reports", "go to settings", "打开导入", "去设置"],
    params: [{ name: "page", type: "enum", required: true, options: PAGES, description: "Which page" }],
  },
  {
    id: "transactions.find", description: "Find transactions", risk: "none",
    expressions: ["show transactions", "find transactions", "search transactions", "list transactions", "show", "find", "search", "search for", "look up", "查找", "搜索", "搜寻", "寻找", "查看", "显示", "找", "查询", "列出"],
    examples: ["show starbucks transactions last month", "find payments over $100", "查找上个月的星巴克", "显示 交通 类别 本月"],
    fillers: TRANSACTION_WORDS,
    params: [queryParam, categoryFilter, periodParam, { name: "amount", type: "money", contextKey: "transactionAmount" }],
  },
  {
    id: "finance.spending", description: "Total spending", risk: "none",
    expressions: ["how much did i spend", "how much have i spent", "how much i spent", "total spending", "spending total", "how much spent", "spent on", "花了多少", "花了多少钱", "支出多少", "消费多少", "总支出", "花费多少", "一共花了"],
    examples: ["how much did I spend on food last month", "上个月餐饮花了多少钱", "total spending this year"],
    fillers: TRANSACTION_WORDS,
    params: [{ ...categoryFilter, markers: ["on", "for", "in", "在", "用于"] }, periodParam, { ...queryParam, description: "Merchant or description" }],
  },
  {
    id: "finance.income", description: "Total income", risk: "none",
    expressions: ["how much did i earn", "how much did i make", "how much income", "total income", "income total", "收入多少", "赚了多少", "总收入", "挣了多少"],
    examples: ["how much did I earn this year", "今年总收入"],
    fillers: TRANSACTION_WORDS,
    params: [periodParam, { ...queryParam, description: "Payer or description" }],
  },
  {
    id: "transactions.categorize", description: "Change the category of matching transactions", risk: "medium", undoable: true,
    expressions: ["categorize", "categorise", "recategorize", "set category", "change category", "change the category of", "move", "file under", "classify", "mark as", "归为", "归到", "归类为", "分类为", "改成", "改为", "设为", "分到", "设置类别", "改类别", "改分类"],
    examples: ["move starbucks to Food & dining", "categorize uber as transport", "把星巴克改成餐饮", "把 Netflix 归为购物"],
    fillers: TRANSACTION_WORDS,
    context: [{ param: "query", requirement: "optional" }],
    params: [
      { ...queryParam, required: true },
      { name: "category", type: "entity", entityKind: "category", required: true, description: "New category", markers: ["to", "as", "into", "under", "为", "成", "到"] },
      periodParam,
    ],
  },
  {
    id: "transactions.exclude", description: "Exclude matching transactions from totals", risk: "medium", undoable: true,
    expressions: ["exclude", "exclude from totals", "leave out", "ignore", "hide from totals", "排除", "不计入", "剔除", "忽略", "不统计"],
    examples: ["exclude venmo transfers", "把 Venmo 排除", "排除上个月的 PayPal"],
    fillers: TRANSACTION_WORDS,
    params: [{ ...queryParam, required: true }, periodParam],
  },
  {
    id: "transactions.include", description: "Count matching transactions in totals again", risk: "medium", undoable: true,
    expressions: ["include", "include again", "count again", "include in totals", "put back", "重新计入", "恢复计入", "计入", "包含", "重新统计"],
    examples: ["include venmo again", "把 Venmo 重新计入"],
    fillers: TRANSACTION_WORDS,
    params: [{ ...queryParam, required: true }, periodParam],
  },
  {
    id: "categories.create", description: "Create a category", risk: "low", undoable: true,
    expressions: ["create category", "add category", "new category", "make category", "add a category", "create a category", "新建类别", "添加类别", "创建类别", "新增类别", "新建分类", "添加分类", "创建分类", "新增分类"],
    examples: ["create category \"Pets\"", "新建类别 宠物"],
    params: [{ name: "name", type: "text", required: true, capture: "remainder", markers: ["called", "named", "叫", "叫做", "名为", "名叫"], maxLength: 40, description: "Category name" }],
  },
  {
    id: "categories.rename", description: "Rename one of your categories", risk: "medium", undoable: true,
    expressions: ["rename category", "rename", "rename the category", "重命名类别", "重命名分类", "类别改名", "分类改名", "改名", "重命名"],
    examples: ["rename category Pets to \"Pet care\"", "把类别 宠物 改名为 宠物护理"],
    params: [
      { name: "from", type: "entity", entityKind: "customCategory", required: true, contextKey: "customCategory", description: "Which of your categories" },
      { name: "to", type: "text", required: true, capture: "marker", markers: ["to", "as", "into", "改成", "改为", "为", "叫", "成"], maxLength: 40, description: "New name" },
    ],
  },
  {
    id: "categories.delete", description: "Delete one of your categories", risk: "high", undoable: true, typedConfirmationParam: "target",
    expressions: ["delete category", "remove category", "delete the category", "删除类别", "删除分类", "删掉类别", "删掉分类", "移除类别", "移除分类"],
    examples: ["delete category Pets", "删除类别 宠物"],
    context: [{ param: "target", requirement: "reference" }],
    params: [{ name: "target", type: "entity", entityKind: "customCategory", required: true, contextKey: "customCategory", description: "Which of your categories" }],
  },
  {
    id: "app.language", description: "Change the interface language", risk: "none",
    expressions: ["change language", "switch language", "set language", "language", "switch to", "use", "切换语言", "更改语言", "语言", "切换到", "换成"],
    examples: ["switch language to Japanese", "语言 繁体中文"],
    params: [{ name: "language", type: "enum", required: true, options: LANGUAGE_OPTIONS, description: "Which language" }],
  },
  {
    id: "app.theme", description: "Change the appearance", risk: "none",
    expressions: ["theme", "appearance", "change theme", "switch to", "use", "主题", "外观", "切换到", "换成"],
    examples: ["switch to dark mode", "切换到深色模式"],
    params: [{ name: "theme", type: "enum", required: true, options: THEME_OPTIONS, description: "Which appearance" }],
  },
];

export const billieRegistry = () => new ActionRegistry(PRODUCT, "1", BILLIE_ACTIONS);
