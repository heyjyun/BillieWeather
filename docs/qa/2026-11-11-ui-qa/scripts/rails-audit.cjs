// Read-only audit of every website page × 6 languages × desktop/tablet/phone. Submits only the login form.
const fs = require("fs"); const path = require("path"); const { inspect, browser: launch } = require("./audit-lib.cjs");
const dir = __dirname; const BASE = "http://localhost:3000"; const PASS = fs.readFileSync(path.join(dir, "preview-pass.txt"), "utf8").trim();
const LOCALES = process.env.LOCALES ? process.env.LOCALES.split(",") : ["en", "zh-CN", "zh-TW", "ja", "ko", "es"];
const VIEWPORTS = [["desktop", 1440, 900], ["tablet", 820, 1100], ["phone", 390, 844]];
const PUBLIC = [["home", "/"], ["features", "/features"], ["about", "/about"], ["download", "/download"], ["sign-in", "/users/sign_in"], ["sign-up", "/users/sign_up"], ["password", "/users/password/new"]];
const APP = [["dashboard", "/app"], ["statements", "/app/statements"], ["transactions", "/app/transactions"], ["transaction-edit", null], ["categories", "/app/categories"], ["forecast", "/app/forecast"], ["insights", "/app/insights"], ["tax", "/app/tax"], ["settings", "/app/settings"], ["report", "/app/report"]];
(async () => {
  const browser = await launch(); const results = []; const shotDir = path.join(dir, "qa", "web"); fs.mkdirSync(shotDir, { recursive: true });
  for (const [vw, w, h] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage(); const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const locale of LOCALES) {
      await page.context().clearCookies();
      for (const [name, url] of PUBLIC) {
        const r = await page.goto(`${BASE}${url}?locale=${locale}`);
        const found = await inspect(page); results.push({ vw, locale, name, status: r.status(), ...found, errors: errors.splice(0) });
        if (locale === "en" || locale === "zh-TW") await page.screenshot({ path: `${shotDir}/${vw}-${locale}-${name}.png`, fullPage: vw !== "phone" });
      }
      await page.goto(`${BASE}/users/sign_in?locale=${locale}`);
      await page.fill("#user_email", "design-preview@billieweather.test"); await page.fill("#user_password", PASS);
      await Promise.all([page.waitForNavigation(), page.click("form [type=submit]")]);
      let editUrl = null;
      for (const [name, url] of APP) {
        const target = url ?? editUrl; if (!target) continue;
        const r = await page.goto(`${BASE}${target}${target.includes("?") ? "&" : "?"}locale=${locale}`);
        if (name === "transactions") editUrl = await page.locator("a[href*='/edit']").first().getAttribute("href").catch(() => null);
        const found = await inspect(page); results.push({ vw, locale, name, status: r.status(), ...found, errors: errors.splice(0) });
        if (locale === "en" || locale === "zh-TW") await page.screenshot({ path: `${shotDir}/${vw}-${locale}-${name}.png`, fullPage: vw !== "phone" });
      }
      await page.goto(`${BASE}/app?locale=en`);
    }
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(dir, "qa", "web-audit.json"), JSON.stringify(results, null, 1));
  const bad = results.filter((r) => r.status >= 400 || r.docOverflow > 0 || r.offscreen.length || r.missingText.length || r.tinyText.length || r.clipped.length || r.errors.length);
  console.log(`checked ${results.length} page renders; ${bad.length} with findings`);
  for (const r of bad) console.log(`${r.vw} ${r.locale} ${r.name} [${r.status}] overflow=${r.docOverflow}`, JSON.stringify({ off: r.offscreen, miss: r.missingText, tiny: r.tinyText, clip: r.clipped, err: r.errors }));
  const targets = results.filter((r) => r.vw === "phone" && r.smallTargets.length);
  console.log(`--- phone small targets (${targets.length} pages)`); for (const r of targets.filter(r => r.locale === "en")) console.log(r.name, r.smallTargets.join(" | "));
})().catch((e) => { console.error(e); process.exit(1); });
