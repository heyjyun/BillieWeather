// BillieWeather's typed-command capabilities, described as data for @nlae/core. This is the single
// source of truth for command definitions on every platform: the universal client (macOS, Windows,
// iOS, Android) and the Rails website both build their registry from here, and the website's
// trusted executor validates against the manifest generated from it (config/smart_command/).
// Everything finance-specific about typed commands lives here; the engine knows none of these words.

import { ActionRegistry, type ActionDefinition, type EntityCandidate, type EnumOption, type ParamSpec } from "@nlae/core";
import { CATEGORIES } from "@billie/shared-types";

/** Registry products. A plan made for one is rejected by the other's executor. */
export const UNIVERSAL_PRODUCT = "billieweather-universal";
export const WEB_PRODUCT = "billieweather-web";

/** Words that describe transactions in general, never part of a search phrase. */
export const TRANSACTION_WORDS = [
  "transactions", "transaction", "payments", "payment", "purchases", "purchase", "charges", "charge", "expenses", "expense", "items", "ones", "records", "entries",
  "交易", "记录", "交易记录", "支出", "消费", "账单", "流水", "款项", "费用", "明细", "的交易", "笔",
];

/**
 * Every page a command can open, on any platform. Each platform lists the ones it has
 * (`UNIVERSAL_PAGES`, `WEB_PAGES`); the same value means the same place everywhere.
 */
export const PAGE_ALIASES: Record<string, string[]> = {
  dashboard: ["home", "overview", "summary page", "首页", "主页", "仪表盘", "概览", "总览"],
  transactions: ["transaction list", "交易", "交易记录", "流水", "明细"],
  categories: ["category", "category page", "类别", "分类", "类别页"],
  import: ["upload", "imports", "导入", "上传", "导入页"],
  reports: ["report", "export", "exports", "报表", "报告", "导出"],
  data: ["database", "databases", "sync", "数据", "数据库", "同步"],
  settings: ["preferences", "options", "设置", "偏好", "设定"],
  forecast: ["forecasts", "cash flow", "cash flow forecast", "projection", "预测", "现金流", "现金流预测"],
  insights: ["insight", "analysis", "advice", "洞察", "分析", "建议"],
  tax: ["taxes", "tax preparation", "tax prep", "税务", "报税", "税务准备"],
};

/** Extra names a page has only on one platform (the website calls its import page "Statements"). */
const WEB_PAGE_EXTRA_ALIASES: Record<string, string[]> = {
  import: ["statements", "statement", "bank statements", "对账单", "银行对账单"],
};

export const UNIVERSAL_PAGES = ["dashboard", "transactions", "categories", "import", "reports", "data", "settings"] as const;
export const WEB_PAGES = ["dashboard", "import", "transactions", "categories", "forecast", "insights", "tax", "reports", "settings"] as const;
export type UniversalPage = (typeof UNIVERSAL_PAGES)[number];
export type WebPage = (typeof WEB_PAGES)[number];

/** Display verbs that are never part of a merchant phrase in a totals question ("显示上个月的支出"). */
const SHOW_WORDS = ["show", "view", "display", "显示", "查看", "看看", "列出"];

const pageOptions = (pages: readonly string[], extra: Record<string, string[]> = {}): EnumOption[] =>
  pages.map((value) => ({ value, aliases: [...PAGE_ALIASES[value], ...(extra[value] ?? [])] }));

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
export const CATEGORY_SYNONYMS: Record<string, string[]> = {
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

/**
 * Built-in categories under every translated name; the person's own exactly as typed.
 * `translations(name)` returns the built-in category's name in every interface language.
 */
export function categoryEntities(customCategories: readonly string[], label: (name: string) => string, translations: (name: string) => readonly string[]): EntityCandidate[] {
  const builtIn = CATEGORIES.map((name) => ({
    id: name, label: label(name), aliases: [...new Set([name, ...translations(name).filter(Boolean), ...(CATEGORY_SYNONYMS[name] ?? [])])],
  }));
  return [...builtIn, ...customCategories.map((name) => ({ id: name, label: name }))];
}

const queryParam = { name: "query", type: "text" as const, capture: "remainder" as const, contextKey: "transactionQuery", maxLength: 80, description: "Which transactions (merchant or description)" };
const periodParam = { name: "period", type: "dateRange" as const, contextKey: "transactionPeriod", markers: ["in", "during", "for", "from", "since", "在", "期间"] };
const categoryFilter = { name: "category", type: "entity" as const, entityKind: "category", contextKey: "transactionCategory", markers: ["in", "on", "for", "under", "category", "类别", "分类"] };

/** Every BillieWeather command. `pages` are the navigate options of the platform building it. */
export function billieActions(pages: EnumOption[]): ActionDefinition[] {
  const navigatePage: ParamSpec = { name: "page", type: "enum", required: true, options: pages, description: "Which page" };
  return [
    {
      id: "app.navigate", description: "Open a page", risk: "none",
      expressions: ["go to", "open", "navigate to", "take me to", "show page", "switch page", "打开", "进入", "跳转到", "前往", "转到", "去"],
      examples: ["open reports", "go to settings", "打开导入", "去设置"],
      params: [navigatePage],
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
      expressions: ["how much did i spend", "how much have i spent", "how much i spent", "total spending", "spending total", "how much spent", "spent on", "花了多少", "花了多少钱", "支出多少", "消费多少", "总支出", "花费多少", "一共花了",
        // "Show my expenses this month" asks for the total, not a list (the gap-tolerant match lets "my" sit in between).
        "show expenses", "show my expenses", "show spending", "show my spending", "显示支出", "查看支出", "我的支出", "的支出", "的花费"],
      examples: ["how much did I spend on food last month", "上个月餐饮花了多少钱", "total spending this year"],
      fillers: [...TRANSACTION_WORDS, ...SHOW_WORDS],
      params: [{ ...categoryFilter, markers: ["on", "for", "in", "在", "用于"] }, periodParam, { ...queryParam, description: "Merchant or description" }],
    },
    {
      id: "finance.income", description: "Total income", risk: "none",
      expressions: ["how much did i earn", "how much did i make", "how much income", "total income", "income total", "收入多少", "赚了多少", "总收入", "挣了多少",
        "show income", "show my income", "显示收入", "查看收入", "我的收入", "的收入"],
      examples: ["how much did I earn this year", "今年总收入"],
      fillers: [...TRANSACTION_WORDS, ...SHOW_WORDS],
      params: [periodParam, { ...queryParam, description: "Payer or description" }],
    },
    {
      id: "finance.balance", description: "Account balances", risk: "none",
      expressions: ["account balance", "account balances", "show balance", "show balances", "show account balance", "show account balances", "show my account balance", "show my account balances", "show my balance", "show my balances", "my balance", "my balances", "what is my balance", "current balance", "how much money do i have", "账户余额", "余额", "查看余额", "显示余额", "我有多少钱", "还有多少钱"],
      examples: ["show my account balances", "账户余额"],
      params: [],
    },
    {
      id: "categories.list", description: "List categories", risk: "none",
      expressions: ["list categories", "show categories", "show my categories", "all categories", "available categories", "which categories", "what categories", "category list", "列出类别", "所有类别", "有哪些类别", "类别列表", "列出分类", "所有分类", "有哪些分类", "分类列表"],
      examples: ["list categories", "有哪些类别"],
      params: [],
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
}

/** What each platform's trusted side implements. A command outside its list is never parsed there. */
export const UNIVERSAL_ACTION_IDS = [
  "app.navigate", "transactions.find", "finance.spending", "finance.income", "transactions.categorize", "transactions.exclude", "transactions.include",
  "categories.create", "categories.rename", "categories.delete", "app.language", "app.theme",
] as const;

/**
 * The website: reads (pages, search, totals, balances, categories) and the reversible writes its
 * Rails executor supports. Deleting categories, language and theme stay on the website's own pages.
 */
export const WEB_ACTION_IDS = [
  "app.navigate", "transactions.find", "finance.spending", "finance.income", "finance.balance", "categories.list",
  "transactions.categorize", "transactions.exclude", "transactions.include", "categories.create", "categories.rename",
] as const;

const pick = (definitions: ActionDefinition[], ids: readonly string[]) => ids.map((id) => {
  const definition = definitions.find((d) => d.id === id);
  if (!definition) throw new Error(`unknown action ${id}`);
  return definition;
});

export const universalActions = (): ActionDefinition[] => pick(billieActions(pageOptions(UNIVERSAL_PAGES)), UNIVERSAL_ACTION_IDS);
export const webActions = (): ActionDefinition[] => pick(billieActions(pageOptions(WEB_PAGES, WEB_PAGE_EXTRA_ALIASES)), WEB_ACTION_IDS);

export const universalRegistry = () => new ActionRegistry(UNIVERSAL_PRODUCT, "1", universalActions());
export const webRegistry = () => new ActionRegistry(WEB_PRODUCT, "1", webActions());
