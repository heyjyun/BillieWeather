// Run against an isolated Vite preview. The SQLite database and account below belong to
// the fresh browser context. Requests outside its loopback origin are intercepted.
import { strict as assert } from "node:assert";
import { chromium, webkit } from "playwright-core";
const origin = process.env.OVERVIEW_ORIGIN ?? "http://127.0.0.1:18480";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const populated = process.env.OVERVIEW_EMPTY !== "1";
const engine = process.env.OVERVIEW_WEBKIT ? webkit : chromium;
const browser = await engine.launch({
  headless: true,
  executablePath: engine === chromium ? process.env.CHROMIUM_EXECUTABLE : undefined,
});
try {
  const ctx = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/Chicago",
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  await ctx.addInitScript(() => {
    sessionStorage.setItem("billie.token", "overview-synthetic");
    localStorage.setItem("billie.locale", "en");
  });
  await ctx.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    const headers = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const account = {
      email: "overview@example.invalid",
      nickname: "Alex",
      locale: "en",
      time_zone: "America/Chicago",
      usage_region: "US",
      registered_at: null,
      owner_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const items = populated
      ? [
          ["Payroll", "2026-11-01", "1800.00", "Income", "income"],
          ["Cafe", "2026-11-12", "-24.00", "Food & dining", "expense"],
          ["Refund", "2026-11-13", "4.00", "Food & dining", "refund"],
          ["Card payment", "2026-11-18", "-320.00", "Transfers", "card_payment"],
        ]
      : [];
    const records = items.map(([description, booked_on, amount, category, kind], i) => ({
      id: i + 1,
      statement_id: 1,
      description,
      booked_on,
      amount,
      category,
      kind,
      excluded: false,
      tax_review: false,
    }));
    const replies = {
      account: { account },
      module_preferences: { format: 2, modules: {}, sidebar_order: null },
      finance: {
        currency: "USD",
        version: "overview-synthetic",
        statement_count: populated ? 1 : 0,
        transaction_count: records.length,
      },
      statements: {
        statements: populated
          ? [
              {
                id: 1,
                filename: "Demo.csv",
                currency: "USD",
                sha256: "e".repeat(64),
                transaction_count: records.length,
                closing_balance: null,
                closing_balance_on: null,
                imported_at: "2026-11-20T10:00:00Z",
              },
            ]
          : [],
      },
      transactions: { transactions: records, next_after_id: null },
      rules: { rules: [] },
      categories: { categories: [] },
    };
    const result = replies[url.pathname.split("/").at(-1)];
    if (!result || req.method() !== "GET") {
      errors.push(req.method() + " " + url.pathname);
      return route.abort();
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(result) });
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(origin);
  await p.getByRole("heading", { name: "Financial Overview", exact: true }).waitFor();
  const amount = p.locator("#dashboard-expenses strong");
  if (populated)
    await p.waitForFunction(() => document.querySelector("#dashboard-expenses strong")?.textContent === "$20.00");
  else {
    await p.getByText("No spending recorded for this period.").waitFor();
    assert.equal(await amount.innerText(), "—");
  }
  assert.equal(await p.locator("[data-widget]").count(), 7);
  assert.equal(await p.locator("#transactions-tabs").count(), 0);
  await p.getByRole("button", { name: "Customize", exact: true }).click();
  await p.getByRole("checkbox", { name: "Net worth", exact: true }).uncheck();
  await p.getByRole("button", { name: "Move up · Recent transactions" }).click();
  await p.getByLabel("Width · Recent transactions").selectOption("full");
  await p.reload();
  await p.locator('[data-widget="recent"]').waitFor();
  assert.equal(await p.locator("#dashboard-worth").count(), 0);
  assert.equal(await p.locator('[data-widget="recent"]').evaluate((el) => el.parentElement.className), "fo-wide");
  await p.getByRole("button", { name: "Customize", exact: true }).click();
  await p.getByRole("button", { name: "Restore default layout" }).click();
  await p.getByRole("button", { name: "Done", exact: true }).click();
  await p.getByLabel("Date range").selectOption("last_month");
  assert.equal(await p.getByLabel("Start date").count(), 0);
  await p.getByLabel("Date range").selectOption("custom");
  await p.getByLabel("Start date").fill("2026-11-12");
  await p.getByLabel("End date").fill("2026-11-13");
  await p.getByRole("button", { name: "Apply dates" }).click();
  if (populated) {
    await p.getByText("Cafe", { exact: true }).waitFor();
    assert.equal(await p.getByText("Payroll", { exact: true }).count(), 0);
    await p
      .locator('[data-widget="spending"]')
      .getByRole("button", { name: "Food & dining", exact: true })
      .click();
    await p.getByRole("heading", { name: "Transactions", exact: true }).waitFor();
    assert.equal(await p.getByText("Payroll", { exact: true }).count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log(
    engine.name(),
    populated ? "populated" : "empty",
    "SQLite, filters, widget order/size, reload and navigation passed",
  );
} finally {
  await browser.close();
}
