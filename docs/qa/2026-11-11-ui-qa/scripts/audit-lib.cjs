// Shared in-page checks for the QA audit. Returns problems found on the current page.
exports.inspect = async (page) => page.evaluate(() => {
  const vw = window.innerWidth;
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0 && !el.closest("[hidden], .bw-sr-only, .bw-visually-hidden, details:not([open]) > :not(summary)"); };
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden") return true; } return false; };
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} "${(el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"`;
  document.documentElement.style.scrollBehavior = "auto"; window.scrollTo(100000, window.scrollY); const realScroll = window.scrollX; window.scrollTo(0, window.scrollY);
  const out = { docOverflow: realScroll, offscreen: [], missingText: [], tinyText: [], smallTargets: [], clipped: [] };
  const all = [...document.querySelectorAll("body *")];
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && !inScroller(el) && getComputedStyle(el).position !== "fixed") out.offscreen.push(label(el));
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 11.5) out.tinyText.push(`${label(el)} ${fs}px`);
      // Text cut off without an intentional ellipsis.
      const s = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 2 && s.overflowX === "hidden" && s.textOverflow !== "ellipsis" && !el.closest(".bw-mix-part")) out.clipped.push(label(el));
    }
    if (el.matches("button, a[href], input:not([type=hidden]), select, summary") && !el.closest("p, li small, .bw-caption, td small")) {
      const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
      if (!inline && (r.height < 32 || r.width < 24)) out.smallTargets.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  const text = document.body.innerText;
  for (const pattern of [/translation missing[^\n]*/gi, /\bbillie\.[a-z_]+\.[a-z_.]+/g, /%\{[a-z_]+\}/g, /\{[a-z][a-zA-Z_]*\}/g, /\b(undefined|NaN|null)\b/g, /\[object Object\]/g]) {
    for (const m of text.matchAll(pattern)) out.missingText.push(m[0].slice(0, 80));
  }
  document.querySelectorAll(".translation_missing").forEach((el) => out.missingText.push("span.translation_missing " + el.title));
  for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = [...new Set(out[k])].slice(0, 12);
  return out;
});
exports.browser = async () => {
  const { chromium } = require("/Users/jyunz/Downloads/BillieWeather/billieweather/clients/universal/node_modules/playwright-core");
  const fs = require("fs"); const root = process.env.HOME + "/Library/Caches/ms-playwright";
  const exe = fs.readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().pop();
  return chromium.launch({ executablePath: `${root}/${exe}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` });
};
