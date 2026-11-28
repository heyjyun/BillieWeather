// Headless captures of /app/accounts in the isolated Rails preview (loopback only, synthetic users).
//   ACCOUNTS_ORIGIN=http://127.0.0.1:18480 ACCOUNTS_TEST_PASSWORD=… CAPTURE_PREFIX=before \
//     node docs/qa/accounts-redesign/capture-web.mjs
// Optional: CAPTURE_SCENES="populated:1440:light:en,many:1440:light:en" to choose scenes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../../clients/universal/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const origin = process.env.ACCOUNTS_ORIGIN ?? "http://127.0.0.1:18480";
assert.equal(new URL(origin).hostname, "127.0.0.1", "captures only run against a loopback preview");
const password = process.env.ACCOUNTS_TEST_PASSWORD;
assert(password, "Set ACCOUNTS_TEST_PASSWORD");
const prefix = process.env.CAPTURE_PREFIX ?? "after";
const out = fileURLToPath(new URL(".", import.meta.url));
const scenes = (process.env.CAPTURE_SCENES ?? "populated:1440:light:en,many:1440:light:en,empty:1440:light:en,populated:390:light:en")
  .split(",").map((s) => { const [user, width, scheme, locale] = s.split(":"); return { user, width: Number(width), scheme, locale }; });
const browser = await chromium.launch({ headless: true, channel: process.env.CHROMIUM_CHANNEL ?? "chrome" });
const failures = [];
try {
  for (const scene of scenes) {
    const context = await browser.newContext({ viewport: { width: scene.width, height: scene.width < 600 ? 844 : 1000 }, colorScheme: scene.scheme,
      locale: scene.locale === "en" ? "en-US" : scene.locale, timezoneId: "America/Chicago", reducedMotion: "reduce" });
    await context.route("**/*", (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push(`${scene.user}: ${e.message}`));
    await page.goto(origin + "/users/sign_in");
    await page.locator("#user_email").fill(`${scene.user}@example.invalid`);
    await page.locator("#user_password").fill(password);
    await page.locator("form#new_user input[type=submit]").click();
    await page.waitForLoadState("networkidle");
    await page.goto(`${origin}/app/accounts?locale=${scene.locale}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    const name = `${prefix}-${scene.user}-${scene.width}${scene.scheme === "dark" ? "-dark" : ""}${scene.locale === "en" ? "" : "-" + scene.locale}.png`;
    await page.screenshot({ path: out + name, fullPage: true });
    console.log("captured", name);
    await context.close();
  }
} finally {
  await browser.close();
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
