// Use the two synthetic accounts in the isolated Rails preview and a clean headless browser context.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
const origin = process.env.OVERVIEW_ORIGIN ?? "http://127.0.0.1:18479";
assert.equal(new URL(origin).hostname, "127.0.0.1");
assert(process.env.OVERVIEW_TEST_PASSWORD, "Set the synthetic preview password");
const translations = JSON.parse(await readFile(new URL("../src/overview/messages.json", import.meta.url), "utf8"));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
try {
  for (const fixture of ["populated", "empty"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1024 },
      locale: "en-US",
      timezoneId: "America/Chicago",
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      if (localStorage.getItem("billie.sidebar") === null) localStorage.setItem("billie.sidebar", "collapsed");
    });
    let failBills = fixture === "populated";
    const errors = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (failBills && url.searchParams.get("section") === "bills") {
        return route.fulfill({ status: 503, body: "Synthetic widget failure" });
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/users/sign_in");
    await page.locator("#user_email").fill(fixture + "@example.invalid");
    await page.locator("#user_password").fill(process.env.OVERVIEW_TEST_PASSWORD);
    await page.locator("form#new_user input[type=submit]").click();
    await page.goto(origin + "/app");
    const widget = (id) => page.locator('[data-widget="' + id + '"]');
    await widget("recent").waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("[data-widget]").count(), 7);
    assert.equal(await page.locator(".fo-metric").count(), 4);
    assert.equal(await page.locator("#transactions-tabs").count(), 0);
    if (fixture === "empty") {
      assert.deepEqual(await page.locator(".fo-metric strong").allTextContents(), ["—", "—", "—", "—"]);
      for (const name of ["Add account", "Add transaction", "Import statement"])
        assert(await page.getByRole("button", { name, exact: true }).isVisible());
      assert.match(await widget("forecast").innerText(), /known cash balance/);
    } else {
      assert.match(await page.locator("#dashboard-worth").innerText(), /33,396/);
      assert.match(await widget("recent").innerText(), /Studio payroll/);
      assert(await widget("bills").getByRole("alert").isVisible());
      failBills = false;
      await widget("bills").getByRole("button", { name: "Retry" }).click();
      await widget("bills").getByText("Internet", { exact: true }).waitFor();
      const forecast = widget("forecast");
      const projections = new Set();
      for (const days of [30, 60, 90]) {
        await forecast.getByRole("button", { name: days + " days" }).click();
        projections.add(await forecast.locator(".fo-projection strong").innerText());
      }
      assert.equal(projections.size, 3);
      await widget("trend").getByRole("slider").press("ArrowLeft");
      assert(await widget("trend").locator("output").isVisible());
      for (const theme of ["dark", "light"]) {
        await page.locator("[data-theme-menu] summary").click();
        await page.locator('[data-theme-choice="' + theme + '"]').click();
        const ratios = await page.evaluate(() => {
          const lum = (value) => {
            const rgb = value
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map((s) => Number(s) / 255)
              .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          };
          const style = (sel) => getComputedStyle(document.querySelector(sel));
          const bg = lum(style(".fo-card").backgroundColor);
          return [
            ".fo-card h2",
            ".fo-empty",
            ".fo-card .fo-link",
            ".fo-bar.income",
            ".fo-bar.expenses",
            ".fo-netline",
          ].map((sel) => {
            const css = style(sel),
              paint = sel.includes("bar.") ? css.fill : sel === ".fo-netline" ? css.stroke : css.color;
            const fg = lum(paint);
            return [sel, (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05)];
          });
        });
        for (const [sel, ratio] of ratios)
          assert(
            ratio >= (sel.includes("bar.") || sel === ".fo-netline" ? 3 : 4.5),
            theme + " " + sel + " contrast " + ratio,
          );
      }
      const preferenceSnapshot = () =>
        page.evaluate(() =>
          Object.fromEntries(
            Object.entries(localStorage).filter(([key]) => !key.startsWith("billie.overview.layout.")),
          ),
        );
      const old = await preferenceSnapshot();
      const editor = page.locator("#overview-editor");
      await page.getByRole("button", { name: "Customize", exact: true }).click();
      await editor.getByRole("checkbox", { name: "Savings rate", exact: true }).check();
      await editor.getByRole("checkbox", { name: "AI financial summary", exact: true }).uncheck();
      const first = editor.locator(".fo-edit-row").nth(0),
        third = editor.locator(".fo-edit-row").nth(2);
      await third.locator(".fo-grip").dragTo(first);
      assert.match(await first.innerText(), /Cash flow forecast/);
      await editor.getByRole("button", { name: "Move down · Cash flow forecast" }).press("Enter");
      await editor.getByLabel("Width · Cash flow forecast").selectOption("full");
      await editor.getByRole("button", { name: "Done" }).click();
      await page.reload();
      await widget("forecast").waitFor();
      assert.equal(await widget("insight").count(), 0);
      assert.equal(await page.locator(".fo-metric").count(), 5);
      assert.equal(await page.locator("[data-widget]").nth(1).getAttribute("data-widget"), "forecast");
      assert(await widget("forecast").evaluate((el) => el.parentElement.classList.contains("fo-wide")));
      assert.deepEqual(await preferenceSnapshot(), old);
      await page.getByRole("button", { name: "Customize", exact: true }).click();
      await editor.getByRole("button", { name: "Restore default layout" }).click();
      await editor.getByRole("button", { name: "Done" }).click();
      await widget("insight").waitFor();
      await page.getByLabel("Account", { exact: true }).selectOption({ label: "Travel wallet" });
      await page.waitForFunction(() =>
        document.querySelector("#dashboard-available strong")?.textContent.includes("280"),
      );
      assert.equal(await page.getByLabel("Currency", { exact: true }).inputValue(), "EUR");
      assert.equal(await page.locator("#dashboard-income strong").innerText(), "—");
      await page.getByLabel("Currency", { exact: true }).selectOption("USD");
      await page.getByLabel("Date range", { exact: true }).selectOption("this_month");
      assert.equal(await page.locator("input[type=date]").count(), 0);
      assert.equal(new URL(page.url()).searchParams.get("preset"), "this_month");
      await page.getByLabel("Date range", { exact: true }).selectOption("custom");
      await page.getByLabel("Start date", { exact: true }).fill("2026-11-01");
      await page.getByLabel("End date", { exact: true }).fill("2026-11-20");
      await page.getByRole("button", { name: "Apply dates" }).click();
      await page.locator("#dashboard-income button").click();
      await page.waitForURL(/transactions/);
      assert.equal(new URL(page.url()).searchParams.get("activity"), "income");
      assert.equal(new URL(page.url()).searchParams.get("start_date"), "2026-11-01");
      assert.match(await page.locator("table tbody").innerText(), /Studio payroll/);
      assert.doesNotMatch(await page.locator("table tbody").innerText(), /Bookshop|Apartment rent/);
      await page.goto(origin + "/app");
      await widget("spending")
        .getByRole("button", { name: /Housing/ })
        .click();
      await widget("spending").getByRole("button", { name: "Rent", exact: true }).click();
      await page.waitForURL(/transactions/);
      assert.equal(new URL(page.url()).searchParams.get("category"), "Rent");
      assert.equal(new URL(page.url()).searchParams.get("activity"), "spending");
      assert.match(await page.locator("table tbody").innerText(), /Apartment rent/);
      assert.doesNotMatch(await page.locator("table tbody").innerText(), /Studio payroll/);
      for (const [locale, c] of Object.entries(translations)) {
        await page.goto(origin + "/app?locale=" + locale);
        await page.locator(".fo-title h1").waitFor();
        assert.equal(await page.locator(".fo-title h1").innerText(), c.title);
        assert.equal(await widget("forecast").locator("h2").innerText(), c.forecast);
      }
      await page.goto(origin + "/app");
      for (const width of [1440, 1024, 768, 390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForFunction(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.querySelector(".fo-dashboard")?.getBoundingClientRect().right <= innerWidth + 1,
        );
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log("Rails Chromium " + fixture + " passed");
  }
} finally {
  await browser.close();
}
