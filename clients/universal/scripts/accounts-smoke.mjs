// Accounts & Assets in the local client (browser SQLite), headless, against an isolated Vite server.
// Every request outside the loopback origin gets a synthetic reply; nothing reaches a real server.
//   npx vite --port 18482 --strictPort --host 127.0.0.1 &
//   ACCOUNTS_ORIGIN=http://127.0.0.1:18482 node scripts/accounts-smoke.mjs        (Chromium)
//   ACCOUNTS_WEBKIT=1 … node scripts/accounts-smoke.mjs                             (WebKit)
//   ACCOUNTS_SHOTS=<dir> also saves desktop and phone screenshots.
import { strict as assert } from "node:assert";
import { chromium, webkit } from "playwright-core";
const origin = process.env.ACCOUNTS_ORIGIN ?? "http://127.0.0.1:18482";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const engine = process.env.ACCOUNTS_WEBKIT ? webkit : chromium;
const shots = process.env.ACCOUNTS_SHOTS;
const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: process.env.CHROMIUM_CHANNEL ?? "chrome" } : {}) });
const errors = [];

async function context(options = {}) {
  const ctx = await browser.newContext({ locale: "en-US", timezoneId: "America/Chicago", viewport: { width: 1360, height: 900 }, reducedMotion: "reduce", ...options });
  await ctx.addInitScript((locale) => {
    sessionStorage.setItem("billie.token", "accounts-synthetic");
    if (!localStorage.getItem("billie.locale")) localStorage.setItem("billie.locale", locale);
  }, options.appLocale ?? "en");
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    const headers = { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,PUT,OPTIONS", "access-control-allow-headers": "authorization,content-type" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const replies = {
      account: { account: { email: "accounts@example.invalid", nickname: "Alex", locale: "en", time_zone: "America/Chicago", usage_region: "US", registered_at: null, owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
      assistant_preferences: {},
      module_preferences: { format: 2, modules: {}, sidebar_order: null },
      finance: { currency: "USD", version: "accounts-synthetic", statement_count: 0, transaction_count: 0 },
      statements: { statements: [] }, transactions: { transactions: [], next_after_id: null }, rules: { rules: [] }, categories: { categories: [] },
    };
    const result = replies[url.pathname.split("/").at(-1)];
    if (!result || (req.method() !== "GET" && !url.pathname.endsWith("/assistant_preferences"))) {
      errors.push(req.method() + " " + url.pathname);
      return route.abort();
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(result) });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  return { ctx, page };
}

async function openAccounts(page) {
  await page.goto(origin);
  const nav = page.getByRole("navigation").first();
  await nav.waitFor();
  // Accounts is not in the default sidebar: Settings › Open Feature Library › Accounts › Open.
  await nav.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open Feature Library" }).click();
  await page.locator('#feature-library [data-module="accounts"]').getByRole("button", { name: /^Open / }).click();
  await page.locator(".at-root").waitFor();
}


try {
  const { ctx, page } = await context();
  await openAccounts(page);
  // Empty ledger: the table says so and the entry methods are offered; nothing is counted as zero.
  await page.getByText("No accounts yet.", { exact: false }).waitFor();
  assert.equal(await page.locator(".at-metric-worth strong").innerText(), "—");

  // The brief's example, through the existing review-and-confirm capture.
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.getByLabel(/Describe your accounts/).fill("I have a Chase checking account ending in 4821 with a balance of $5,200, and an American Express credit card with $830 outstanding.");
  await page.getByRole("button", { name: "Review proposed accounts" }).click();
  const proposals = page.locator("fieldset").filter({ has: page.getByLabel("Include account") });
  assert.equal(await proposals.count(), 2, "two proposals to review");
  assert.equal(await proposals.first().getByLabel("Last four digits").inputValue(), "4821");
  assert.equal(await proposals.first().getByLabel("Institution", { exact: true }).inputValue(), "Chase");
  assert.equal(await proposals.last().getByLabel("How much do you currently owe?").inputValue(), "830");
  // Nothing is written before the person confirms.
  assert.equal(await page.locator("tr[data-account]").count(), 0);
  for (const proposal of await proposals.all()) await proposal.getByLabel("Balance date").fill("2026-11-26");
  await page.getByRole("button", { name: "Confirm selected accounts" }).click();
  await page.locator("tr[data-account]").nth(1).waitFor();

  // A manual cash account with no date, created through the existing form.
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.getByRole("button", { name: "Create manually" }).first().click();
  const form = page.getByRole("form", { name: "New account" });
  await form.getByLabel("Name").fill("Wallet cash");
  await form.getByLabel("Type").selectOption("cash");
  await form.getByLabel(/How much/).fill("140");
  await form.getByRole("button", { name: "Save" }).click();
  await page.locator("tr[data-account]").nth(2).waitFor();

  const chase = page.locator("tr[data-account]").filter({ hasText: "4821" });
  assert.match(await chase.innerText(), /Chase[\s\S]*•••• 4821[\s\S]*\$5,200\.00[\s\S]*Nov 26, 2026[\s\S]*Updated by hand/);
  const amex = page.locator("tr[data-account]").filter({ hasText: /American Express|Amex/i });
  assert.match(await amex.innerText(), /\$830\.00/);
  assert.match(await page.locator("tr[data-account]").filter({ hasText: "Wallet cash" }).innerText(), /Date not recorded/);
  await page.waitForFunction(() => document.querySelector(".at-metric-worth strong")?.textContent === "$4,510.00");
  assert.equal(await page.locator(".at-metric-liquid strong").innerText(), "$5,340.00");
  assert.deepEqual(await page.locator("tr.at-heading-group .at-heading-name").allInnerTexts(), ["Liquid assets", "Liabilities"]);
  if (shots) await page.screenshot({ path: `${shots}/sqlite-${engine.name()}-populated.png`, fullPage: true });

  // Search, filter, sort.
  const search = page.getByLabel("Search accounts");
  await search.fill("4821");
  assert.equal(await page.locator("tr[data-account]").count(), 1);
  await search.fill("");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByLabel("Class").selectOption("liability");
  assert.equal(await page.locator("tr[data-account]").count(), 1);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Sort", exact: true }).click();
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("name");
  await page.keyboard.press("Escape");
  // Sorting is within each group; Liquid assets holds the checking and cash accounts.
  const liquid = await page.locator('tr[data-account]:not([data-group]) .at-name').allInnerTexts();
  const ordered = [...liquid].slice(0, 2);
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a.localeCompare(b, "en")), "sorted by name");

  // Row menu: update a balance; the date becomes the confirmed date.
  await page.locator("tr[data-account]").filter({ hasText: "Wallet cash" }).getByRole("button", { name: /Actions for Wallet cash/ }).click();
  await page.getByRole("menuitem", { name: "Update balance" }).click();
  const adjust = page.getByRole("form", { name: /Set the balance|Adjust|balance/i });
  await adjust.locator("input[inputmode=decimal]").fill("120");
  await adjust.locator("input[type=date]").fill("2026-11-27");
  await adjust.getByRole("button").first().click();
  await page.locator("tr[data-account]").filter({ hasText: "Wallet cash" }).filter({ hasText: "Nov 27, 2026" }).waitFor();

  // Archive: hidden from the active list, still counted in net worth (it is included).
  await page.locator("tr[data-account]").filter({ hasText: "Wallet cash" }).getByRole("button", { name: /Actions for Wallet cash/ }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
  await page.locator("tr[data-account]").filter({ hasText: "Wallet cash" }).waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector(".at-metric-worth strong")?.textContent === "$4,490.00");
  assert.equal(await page.locator(".at-metric-liquid strong").innerText(), "$5,200.00");

  // Keyboard: arrow between rows, Enter opens the account.
  await page.locator("tr[data-account]").first().focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-account") !== null), true);
  await page.keyboard.press("Enter");
  await page.getByRole("form", { name: "Edit account" }).waitFor();
  await page.getByRole("form", { name: "Edit account" }).getByRole("button", { name: "Cancel" }).click();

  if (shots) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${shots}/sqlite-${engine.name()}-phone.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.querySelector(".at-root").scrollWidth <= innerWidth), "no horizontal scrolling on a phone");
  }
  // Hide balances, hide a column, collapse a group: all remembered after a reload. (The browser
  // preview keeps its SQLite in memory, so a reload starts an empty book; the settings stay.)
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole("button", { name: "Hide balances" }).click();
  assert.equal(await page.locator("tr[data-account] .at-col-balance .at-masked").count(), 2);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("checkbox", { name: "Currency" }).uncheck();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("thead .at-col-currency").count(), 0);
  await page.getByRole("button", { name: "Collapse Liabilities" }).click();
  assert.equal(await page.locator("tr[data-account]").filter({ hasText: "830" }).count(), 0);
  await page.reload();
  await openAccounts(page);
  assert.equal(await page.locator(".at-metric-worth .at-masked").count(), 1);
  const saved = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("billie.accounts.table.v1:")).map(([, value]) => JSON.parse(value)));
  assert.equal(saved.length, 1, "one settings record for the signed-in owner");
  assert.deepEqual([saved[0].hidden, saved[0].collapsed, saved[0].hideBalances, saved[0].sort.key], [["currency"], ["liabilities"], true, "name"]);
  await ctx.close();

  assert.deepEqual(errors, []);
  console.log(engine.name(), "SQLite accounts: capture, table, search, filter, sort, preferences, balance update, archive and keyboard passed");
} finally {
  await browser.close();
}
