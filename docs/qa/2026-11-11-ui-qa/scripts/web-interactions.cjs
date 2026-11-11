// Read-only interaction checks on the website. Never submits a destructive form.
const fs=require("fs"),path=require("path");const {browser}=require("./audit-lib.cjs");
const PASS=fs.readFileSync(path.join(__dirname,"preview-pass.txt"),"utf8").trim(); const B="http://localhost:3000";
const results=[]; const check=(vw,name,ok,detail="")=>results.push({vw,name,ok:!!ok,detail});
(async()=>{const b=await browser();
for (const [vw,w,h] of [["desktop",1440,900],["phone",390,844]]) {
  const ctx=await b.newContext({viewport:{width:w,height:h}}); const p=await ctx.newPage(); const errs=[]; p.on("pageerror",e=>errs.push(e.message));
  // Public: support dialog opens and Escape closes it, focus returns to the trigger.
  await p.goto(B+"/?locale=en");
  const trigger=p.locator(".bw-public-support-link").first();
  if (vw==="phone" && !(await trigger.isVisible())) check(vw,"support link visible",false); else {
    await trigger.click(); check(vw,"support dialog opens",await p.locator("#support-dialog[open]").count());
    await p.keyboard.press("Escape"); check(vw,"support dialog closes on Escape",!(await p.locator("#support-dialog[open]").count()));
    check(vw,"focus returns to support trigger",await p.evaluate(()=>document.activeElement?.classList.contains("bw-public-support-link")));
  }
  // Sign in
  await p.goto(B+"/users/sign_in?locale=en"); await p.fill("#user_email","design-preview@billieweather.test"); await p.fill("#user_password",PASS);
  await Promise.all([p.waitForNavigation(),p.click("form [type=submit]")]); check(vw,"sign in reaches dashboard",p.url().includes("/app"));
  // Navigation: every sidebar link resolves and becomes the active item.
  const links=await p.locator(".bw-nav a.bw-nav-link").evaluateAll(as=>as.map(a=>a.getAttribute("href")));
  for (const href of links){ const r=await p.goto(B+href); const active=await p.locator(`.bw-nav a.bw-nav-link.is-active[href='${href}']`).count(); check(vw,`nav ${href}`,r.status()<400&&active,`status ${r.status()} active=${active}`); }
  if (vw==="phone") { const last=p.locator(".bw-nav a.bw-nav-link").last(); await last.scrollIntoViewIfNeeded(); check(vw,"last tab reachable by scrolling the tab bar",await last.isVisible()); }
  await p.goto(B+"/app");
  // Theme menu: choose Dark, survives reload, back to System.
  const menu=p.locator(".bw-topbar .bw-theme-menu"); check(vw,"theme menu visible after script",await menu.isVisible());
  await menu.locator("summary").click(); await menu.locator("[data-theme-choice=dark]").click();
  check(vw,"dark theme applied",await p.evaluate(()=>document.documentElement.dataset.theme==="dark"));
  await p.reload(); check(vw,"dark theme persists after reload",await p.evaluate(()=>document.documentElement.dataset.theme==="dark"));
  check(vw,"dark background token in effect",await p.evaluate(()=>getComputedStyle(document.body).backgroundColor==="rgb(23, 19, 28)"));
  await menu.locator("summary").click(); await menu.locator("[data-theme-choice=system]").click();
  check(vw,"system theme restores",await p.evaluate(()=>!document.documentElement.hasAttribute("data-theme")&&localStorage.getItem("billie.theme")===null));
  // Escape and outside click close menus.
  await p.locator(".bw-topbar .bw-language-menu summary").click(); check(vw,"language menu opens",await p.locator(".bw-topbar .bw-language-menu[open]").count());
  await p.keyboard.press("Escape"); check(vw,"language menu closes on Escape",!(await p.locator(".bw-topbar .bw-language-menu[open]").count()));
  await p.locator(".bw-topbar .bw-language-menu summary").click(); await p.mouse.click(w/2,h-200);
  check(vw,"language menu closes on outside click",!(await p.locator(".bw-topbar .bw-language-menu[open]").count()));
  // Sidebar collapse (desktop only)
  if (vw==="desktop") {
    const t=p.locator("[data-sidebar-toggle]"); await t.click(); await p.waitForTimeout(400);
    check(vw,"sidebar collapses",await p.evaluate(()=>document.documentElement.dataset.sidebar==="collapsed"&&document.querySelector(".bw-sidebar").getBoundingClientRect().width===72));
    check(vw,"collapsed nav keeps accessible names",await p.locator(".bw-nav a", {hasText:"Transactions"}).count()===1);
    await p.reload(); check(vw,"collapsed state persists",await p.evaluate(()=>document.documentElement.dataset.sidebar==="collapsed"));
    check(vw,"toggle label says Expand when collapsed",(await t.getAttribute("aria-label"))==="Expand sidebar"&&(await t.getAttribute("aria-expanded"))==="false");
    await t.click(); check(vw,"sidebar expands again",await p.evaluate(()=>!document.documentElement.dataset.sidebar));
  } else check(vw,"sidebar toggle hidden on phones",!(await p.locator("[data-sidebar-toggle]").isVisible()));
  // Upload: drop a CSV onto the box fills the file input (not submitted).
  await p.goto(B+"/app/statements");
  const dropped=await p.evaluate(()=>{const zone=document.querySelector("[data-dropzone]");const dt=new DataTransfer();dt.items.add(new File(["Date,Description,Amount\n"],"dropped.csv",{type:"text/csv"}));
    zone.dispatchEvent(new DragEvent("dragenter",{dataTransfer:dt,bubbles:true}));const over=zone.classList.contains("is-dragover");
    zone.dispatchEvent(new DragEvent("drop",{dataTransfer:dt,bubbles:true,cancelable:true}));
    return {over,files:document.querySelector("#files").files.length,listed:[...document.querySelectorAll("[data-dropzone-files] li")].map(l=>l.textContent)}});
  check(vw,"drop highlights the upload box",dropped.over); check(vw,"dropped file fills the input and is listed",dropped.files===1&&dropped.listed[0]==="dropped.csv",JSON.stringify(dropped));
  // Privacy dialogs open and close without submitting.
  await p.goto(B+"/app/settings");
  for (const id of ["privacy-delete-data-dialog","privacy-delete-account-dialog"]) {
    await p.locator(`[data-dialog-open='${id}']`).click(); check(vw,`${id} opens`,await p.locator(`#${id}[open]`).count());
    const box=await p.locator(`#${id}`).boundingBox(); check(vw,`${id} fits the screen`,box&&box.x>=0&&box.x+box.width<=w&&box.height<=h,JSON.stringify(box));
    await p.keyboard.press("Escape"); check(vw,`${id} closes on Escape`,!(await p.locator(`#${id}[open]`).count()));
  }
  // Region search on Settings filters the long list.
  const rs=p.locator("[data-region-search-input]").first();
  if (await rs.count()) { await rs.fill("taiw"); const opts=await p.locator("[data-region-search] select option").evaluateAll(o=>o.map(x=>x.value).filter(Boolean)); check(vw,"region search filters",opts.includes("TW")&&opts.length<10,opts.join(",")); await rs.fill(""); }
  // Forecast scenario form (GET only) changes the projection, not the data.
  await p.goto(B+"/app/forecast?engine=linear&days=60&income_adjustment=10&expense_adjustment=0");
  check(vw,"forecast scenario renders with chosen horizon",(await p.locator("#forecast-projected-balance").innerText()).includes("60"));
  check(vw,"no page errors",errs.length===0,errs.join("; "));
  await ctx.close();
}
await b.close(); fs.writeFileSync(path.join(__dirname,"qa","web-interactions.json"),JSON.stringify(results,null,1));
const failed=results.filter(r=>!r.ok); console.log(`${results.length} checks, ${failed.length} failed`); for(const f of failed) console.log("FAIL",f.vw,f.name,f.detail);
})().catch(e=>{console.error(e);process.exit(1)});
