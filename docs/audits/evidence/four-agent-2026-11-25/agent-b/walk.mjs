import { chromium } from "$SCRATCH/repo/clients/universal/node_modules/playwright-core/index.mjs";
const BASE = "http://127.0.0.1:3212";
const browser = await chromium.launch({ executablePath: process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell" });
const page = await browser.newPage();
const out = [];
const log = (k, v) => { out.push([k, v]); console.log(k, "=>", JSON.stringify(v)); };
await page.goto(BASE + "/users/sign_in");
await page.fill("input[name='user[email]']", "agentb-synthetic@example.test");
await page.fill("input[name='user[password]']", "Synthetic-Pass-9x!");
await Promise.all([page.waitForNavigation(), page.click("form#new_user [type=submit], form [type=submit]")]);
log("after sign-in url", page.url());
await page.goto(BASE + "/app");
log("nav modules", await page.$$eval("nav a, nav button", (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, " ")).filter(Boolean)));
const links = await page.$$eval("main a", (els) => els.map((e) => [e.textContent.trim().replace(/\s+/g, " "), e.getAttribute("href")]));
log("dashboard links", links);
for (const [label, href] of links.filter(([, h]) => h && /\/app\/(report|forecast|categories|accounts|budgets|recurring|ledger)/.test(h))) {
  const r = await page.goto(BASE + href);
  const disabled = await page.$("#module-disabled");
  log(`follow ${label} ${href}`, { status: r.status(), disabledPage: !!disabled, h1: await page.$eval("h1", (e) => e.textContent.trim()).catch(() => null) });
}
await page.goto(BASE + "/app/settings");
const sl = await page.$$eval("#settings-privacy a, main a", (els) => els.map((e) => [e.textContent.trim(), e.getAttribute("href")]).filter(([, h]) => h && h.includes("report")));
log("settings export links", sl);
for (const [label, href] of sl.slice(0, 1)) { const r = await page.goto(BASE + href); log(`follow settings ${label}`, { status: r.status(), disabledPage: !!(await page.$("#module-disabled")) }); }
await page.goto(BASE + "/app/add-sync").catch(() => null);
log("add-sync url/status", page.url());
log("add-sync connect card", await page.$eval("#capability-connect", (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => "absent"));
log("connect card interactive elements", await page.$$eval("#capability-connect a, #capability-connect button, #capability-connect form", (els) => els.length).catch(() => -1));
await page.screenshot({ path: "$SCRATCH/walk/addsync.png", fullPage: true });
await browser.close();
