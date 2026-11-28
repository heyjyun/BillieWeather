import { institutionIn } from "./account-capture.mjs";

// Only active, owned rows from the selected book may be supplied. Navigation is resolved by
// each client against its supported routes. Advice never calls a financial write.
export function nextSteps(facts, page, state = {}, now = Date.now()) {
  if (state.enabled === false) return [];
  const candidates = [];
  const accounts = facts.accounts.filter(a => !a.archived);
  const add = (kind, priority, detail = "", target = "", context = [], subject = "", label = kind) => {
    const preference = ["budget","forecast","recurring","report"].includes(kind) ? "planning" : "organization";
    if (state[preference] === false) return;
    const key = subject ? kind + ":" + subject : kind;
    const saved = state[key];
    if (saved?.status === "dismissed" || (saved?.status === "completed" && ["forecast","report"].includes(kind) && saved.until > now) ||
        (saved?.status === "deferred" && saved.until > now)) return;
    if (!facts.available.includes(kind)) return;
    // Opening a review does not mark its underlying condition resolved. Allow the user to resume it.
    candidates.push({kind, key, label, target, detail: String(detail), priority: priority + (context.includes(page) ? 24 : 0)});
  };
  if (!accounts.length && page !== "accounts") add("account", 90);
  if (accounts.length && !facts.transactions && !facts.statements) add("import", 84, "", "", ["accounts", "transactions"]);
  else if (accounts.length && facts.latest && now - Date.parse(facts.latest) > 45 * 86400000)
    add("import",57,facts.latest,"",["import","transactions"]);
  if (facts.unclassified) add("classify", 78, facts.unclassified, "", ["categories", "transactions"]);
  if (facts.duplicates) add("duplicates", 88, facts.duplicates, "", ["transactions"]);
  if (facts.matches) add("matches", 80, facts.matches, "", ["accounts", "transactions"]);
  for (const account of accounts.filter(a => a.pending || a.observation)) {
    add("reconcile", account.observation ? 82 : 65, [account.name,account.observation].filter(Boolean).join(" · "), String(account.id), ["accounts"], String(account.id));
  }
  const banks = new Map();
  const payments = new Map();
  for (const row of facts.recent) {
    const bank = institutionIn(row.description);
    if (bank && ["transfer","card_payment"].includes(row.kind) && row.cents < 0) {
      const records = banks.get(bank) || [];
      records.push(row);
      banks.set(bank, records);
    }
    if (row.kind !== "expense" || row.cents >= 0) continue;
    const key = row.description.trim().toLowerCase() + "|" + row.cents;
    const records = payments.get(key) || [];
    records.push(row);
    payments.set(key, records);
  }
  for (const [bank, rows] of banks) {
    const exists = facts.accounts.some(a => [a.institution, a.name].some(name => name && name.toLowerCase().includes(bank.toLowerCase())));
    if (!exists && new Set(rows.map(r => r.date)).size >= 2) {
      add("discover", 69, bank + " · " + rows.slice(0,3).map(r => r.date + " " + r.description).join(" / "), bank, ["accounts"], String(rows.at(-1).id));
    }
  }
  for (const rows of payments.values()) {
    const dates = [...new Set(rows.map(r => r.date))].sort().slice(-3);
    if (dates.length !== 3 || facts.scheduled.some(name => name.toLowerCase() === rows[0].description.toLowerCase())) continue;
    const days = dates.map(d => Date.parse(d) / 86400000);
    const gaps = [days[1] - days[0], days[2] - days[1]];
    if (!gaps.every(gap => gap >= 26 && gap <= 35) && !gaps.every(gap => gap >= 6 && gap <= 8)) continue;
    add("recurring", 53, rows[0].description + " · " + dates.join(" / "), rows[0].description, ["recurring"], String(rows.at(-1).id));
  }
  if (facts.budgets && facts.remaining != null && facts.remaining < 0)
    add("budget",85,facts.currency + " " + (-facts.remaining / 100).toFixed(2),"",["budgets"],"","overBudget");
  const months = Object.keys(facts.months).sort();
  if (months.length >= 2) {
    const history = months.join(", ");
    if (!facts.budgets && months.length >= 3) {
      const last = months.slice(-3);
      const average = Math.round(last.reduce((sum, m) => sum + facts.months[m], 0) / last.length);
      if (average > 0) add("budget", 51, facts.currency + " " + (average / 100).toFixed(2) + " · " + last.join(", "), String(average), ["budgets"]);
    }

    const last = months.at(-1);
    const earlier = months.slice(-4,-1);
    const typical = earlier.map(m => facts.months[m]).sort((a,b) => a-b)[1];
    const spike = earlier.length === 3 && typical > 0 && facts.months[last] >= typical * 1.5;
    const evidence = spike ? [last, facts.currency + " " + (facts.months[last]/100).toFixed(2),
      earlier.join(", "),facts.currency + " " + (typical/100).toFixed(2)].join(" · ") : history;
    add("report", spike ? 72 : 42, evidence, "", ["reports"],"",spike ? "spendingChange" : "report");
  }
  if (facts.forecastReady) add("forecast", facts.shortfall ? 97 : 48, facts.shortfall || months.join(", "), "", ["forecast"]);
  return candidates.sort((a,b) => b.priority - a.priority || a.key.localeCompare(b.key));
}

// Verify accepted tasks against a fresh book projection before resolving their receipt.
export function resolvedChoices(facts, state) {
  const active = new Set(nextSteps(facts, "dashboard").map(item => item.key));
  const changes = [];
  for (const [key, receipt] of Object.entries(state)) {
    if (receipt?.status !== "accepted" || active.has(key)) continue;
    const [kind,id] = key.split(":");
    if (!facts.available.includes(kind)) continue;
    let complete;
    if (kind === "account") complete = facts.accounts.some(a => !a.archived);
    else if (kind === "import") complete = facts.statements > 0;
    else if (kind === "reconcile") complete = facts.accounts.some(a => String(a.id) === id && !a.pending && !a.observation && !a.archived);
    else if (kind === "budget") complete = facts.budgets > 0;
    else if (kind === "classify") complete = facts.transactions > 0 && !facts.unclassified;
    else if (kind === "discover") {
      const source = facts.recent.find(row => String(row.id) === id);
      const bank = source && institutionIn(source.description);
      complete = bank && facts.accounts.some(a => [a.name,a.institution].some(n => n?.toLowerCase().includes(bank.toLowerCase())));
    } else if (kind === "recurring") {
      const source = facts.recent.find(row => String(row.id) === id);
      complete = source && facts.scheduled.some(n => n.toLowerCase() === source.description.toLowerCase());
    }
    changes.push([key, {status:complete ? "completed" : "invalidated"}]);
  }
  return changes;
}

const topics = {
  account: /accounts?|cuentas?|账户|帳戶|口座|계좌/i, budget: /budget|presupuesto|预算|預算|予算|예산/i,
  forecast: /forecast|cash flow|pron[oó]stico|预测|預測|予測|예측/i, recurring: /recurring|subscription|recurrent|定期|周期|週期|구독/i,
  duplicates: /duplicat|duplicad|重复|重複|중복/i, matches: /transfer|relationship|转账|轉帳|振替|이체/i,
  classify: /classif|categor|分类|分類|분류/i, import: /import|statement|账单|帳單|明細|명세/i,
  report: /report|spending|informe|报告|報告|支出|보고/i, reconcile: /balance|reconcil|saldo|余额|餘額|残高|잔액/i,
  discover: /missing|discover|faltante|缺失|遗漏|遺漏|未登録|누락/i,
};
export function selectSuggestion(text, items) {
  const query = text.trim();
  if (!query) return items;
  const topicsAsked = Object.keys(topics).filter(k => topics[k].test(query));
  return items.filter(item => topicsAsked.includes(item.kind) || (item.target && item.target.length >= 3 && query.toLowerCase().includes(item.target.toLowerCase())));
}

export function mountNext(root, { facts, page, state, copy, choose, save }) {
  let query = "";
  let explanation = false;
  const perform = async (item,status) => {
    const change = {status};
    if (status === "deferred") change.until = Date.now() + 7 * 86400000;
    await save(item.key,change);
    state[item.key] = change;
    if (status === "accepted") choose(item);
  };
  const targetPages = {account:"accounts",import:"import",classify:"transactions",duplicates:"transactions",matches:"transactions",discover:"accounts",reconcile:"accounts",recurring:"recurring",budget:"budgets",forecast:"forecast",report:"reports"};
  const changes = resolvedChoices(facts,state);
  for (const kind of ["report","forecast"]) {
    if (state[kind]?.status === "accepted" && page === targetPages[kind]) {
      changes.push([kind,{status:"completed",until:Date.now() + 7 * 86400000}]);
    }
  }
  for (const [key,value] of changes) {
    void save(key,value,state[key]).then(() => {state[key] = value;}).catch(() => {});
  }
  function elReason(text) {
    const reason = document.createElement("p");
    reason.textContent = text;
    return reason;
  }
  function render() {
    root.replaceChildren();
    const items = nextSteps(facts, page, state).filter(item => !(state[item.key]?.status === "accepted" && targetPages[item.kind] === page));
    if (!items.length) return;
    const section = document.createElement("section");
    section.className = "bw-panel bw-section-gap bw-next-step";
    const heading = document.createElement("h2");
    heading.textContent = copy.next;
    section.append(heading);
    const limit = page === "assistant" ? 3 : 1;
    if (page === "assistant") {
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.value = query;
      input.maxLength = 160;
      input.setAttribute("aria-label", copy.askAction);
      input.placeholder = copy.askAction;
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "bw-button bw-button-outline";
      submit.textContent = copy.reviewAction;
      form.append(input, submit);
      form.onsubmit = async event => {
        event.preventDefault();
        query = input.value;
        const matches = selectSuggestion(query,items);
        explanation = /why|explain|por qu[eé]|explica|为什么|為什麼|理由|なぜ|왜|이유/i.test(query);
        const defer = /^(?:defer|postpone|later|aplaza|posp[oó]n|稍后|稍後|推迟|延後|後で|나중에)/i.test(query.trim());
        const open = /^(?:open|review|show me|abre|revisa|查看|打开|開啟|確認する|열기|검토)/i.test(query.trim());
        if (matches.length === 1 && !explanation && (defer || open)) {
          submit.disabled = true;
          try { await perform(matches[0],defer ? "deferred" : "accepted"); query = ""; }
          catch { section.append(document.createTextNode(copy.actionFailure)); submit.disabled = false; return; }
        }
        render();
        root.querySelector("form input")?.focus();
      };
      section.append(form);
    }
    const visible = selectSuggestion(query,items);
    if (!visible.length) section.append(document.createTextNode(copy.noAction));
    for (const item of visible.slice(0, limit)) {
      const row = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = copy[item.kind === "forecast" && facts.shortfall ? "shortfall" : item.kind === "import" && facts.latest ? "stale" : item.label];
      row.append(title);
      if (explanation) row.append(elReason(copy[["report","budget","forecast","recurring"].includes(item.kind) ? "whyPlanning" : "whyOrganize"]));
      if (item.detail) {
        const evidence = document.createElement("p");
        evidence.textContent = item.detail;
        row.append(evidence);
      }
      const actions = document.createElement("div");
      actions.className = "bw-heading-actions";
      for (const [key,status] of [["reviewAction","accepted"],["later","deferred"],["dismiss","dismissed"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = key === "reviewAction" ? "bw-button bw-button-outline" : "bw-link-button";
        button.textContent = copy[key];
        button.onclick = async () => {
          for (const b of actions.children) b.disabled = true;
          try {
            await perform(item,status);
            render();
          } catch {
            title.textContent = copy.actionFailure;
            for (const b of actions.children) b.disabled = false;
          }
        };
        actions.append(button);
      }
      row.append(actions);
      section.append(row);
    }
    root.append(section);
  }
  render();
}
