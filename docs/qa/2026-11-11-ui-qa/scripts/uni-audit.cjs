// Audit of the universal client (browser build; data in memory only) × 6 languages × 3 sizes.
const fs = require("fs"); const path = require("path"); const { inspect, browser: launch } = require("./audit-lib.cjs");
const dir = __dirname; const PASS = fs.readFileSync(path.join(dir, "preview-pass.txt"), "utf8").trim();
const LOCALES = process.env.LOCALES ? process.env.LOCALES.split(",") : ["en", "zh-CN", "zh-TW", "ja", "ko", "es"];
const VIEWPORTS = [["desktop", 1280, 860], ["tablet", 820, 1100], ["phone", 390, 844]];
const PAGES = ["dashboard", "transactions", "categories", "import", "reports", "data", "settings"];
(async () => {
  const browser = await launch(); const results = []; const shotDir = path.join(dir, "qa", "app"); fs.mkdirSync(shotDir, { recursive: true });
  for (const [vw, w, h] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage(); const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:1420/");
    await page.waitForSelector(".bw-login-card");
    results.push({ vw, locale: "en", name: "login", ...(await inspect(page)), errors: errors.splice(0) });
    await page.screenshot({ path: `${shotDir}/${vw}-en-login.png` });
    await page.fill("input[type=email]", "design-preview@billieweather.test"); await page.fill("input[type=password]", PASS);
    await page.click("button[type=submit]");
    for (let i = 0; i < 20 && !(await page.locator(".bw-nav-item").count()); i++) {
      const submit = page.locator("form button[type=submit]").first();
      if (await submit.count() && await submit.isEnabled()) await submit.click().catch(() => {});
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2000);
    for (const locale of LOCALES) {
      await page.locator(".bw-nav-item").nth(6).click();
      await page.selectOption("#settings-language", locale); await page.waitForTimeout(600);
      for (let i = 0; i < PAGES.length; i++) {
        await page.locator(".bw-nav-item").nth(i).click(); await page.waitForTimeout(400);
        if (PAGES[i] === "import") {
          await page.setInputFiles(".bw-dropzone input[type=file]", path.join(dir, "sample.csv")); await page.waitForTimeout(1200);
          results.push({ vw, locale, name: "import-preview", ...(await inspect(page)), errors: errors.splice(0) });
          if (locale === "en" || locale === "zh-TW") await page.screenshot({ path: `${shotDir}/${vw}-${locale}-import-preview.png`, fullPage: vw !== "phone" });
          const cancel = page.locator(".bw-review-actions button.bw-button-outline, button:has-text('Cancel')").first();
          if (await cancel.count()) await cancel.click().catch(() => {});
          await page.waitForTimeout(300);
        }
        results.push({ vw, locale, name: PAGES[i], ...(await inspect(page)), errors: errors.splice(0) });
        if (locale === "en" || locale === "zh-TW") await page.screenshot({ path: `${shotDir}/${vw}-${locale}-${PAGES[i]}.png`, fullPage: vw !== "phone" });
      }
    }
    await page.locator(".bw-nav-item").nth(6).click(); await page.selectOption("#settings-language", "en"); await page.waitForTimeout(400);
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(dir, "qa", "app-audit.json"), JSON.stringify(results, null, 1));
  const bad = results.filter((r) => r.docOverflow > 0 || r.offscreen.length || r.missingText.length || r.tinyText.length || r.clipped.length || r.errors.length);
  console.log(`checked ${results.length} screen renders; ${bad.length} with findings`);
  for (const r of bad) console.log(`${r.vw} ${r.locale} ${r.name} overflow=${r.docOverflow}`, JSON.stringify({ off: r.offscreen.slice(0,3), miss: r.missingText, tiny: r.tinyText.slice(0,4), clip: r.clipped.slice(0,3), err: r.errors }));
  console.log("--- phone small targets (en)"); for (const r of results.filter((r) => r.vw === "phone" && r.locale === "en" && r.smallTargets.length)) console.log(r.name, r.smallTargets.join(" | "));
})().catch((e) => { console.error(e); process.exit(1); });
