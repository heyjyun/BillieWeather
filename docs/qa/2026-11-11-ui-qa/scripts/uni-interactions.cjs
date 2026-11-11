// Interaction checks in the universal client's browser build (in-memory database; nothing persisted).
// Destructive confirmations are opened and cancelled, never confirmed.
const fs=require("fs"),path=require("path");const {browser}=require("./audit-lib.cjs");
const PASS=fs.readFileSync(path.join(__dirname,"preview-pass.txt"),"utf8").trim();
const results=[]; const check=(vw,name,ok,detail="")=>results.push({vw,name,ok:!!ok,detail});
(async()=>{const b=await browser();
for (const [vw,w,h] of [["desktop",1280,860],["phone",390,844]]) {
  const ctx=await b.newContext({viewport:{width:w,height:h}}); const p=await ctx.newPage(); const errs=[]; p.on("pageerror",e=>errs.push(e.message));
  const net=[]; p.on("request",r=>net.push(r.method()+" "+r.url()));
  await p.goto("http://localhost:1420/"); await p.waitForSelector(".bw-login-card");
  await p.fill("input[type=email]","design-preview@billieweather.test"); await p.fill("input[type=password]","wrong-password"); await p.click("button[type=submit]");
  check(vw,"wrong password shows an error",await p.locator(".bw-message-error, [role=alert]").first().waitFor({timeout:8000}).then(()=>true).catch(()=>false));
  await p.fill("input[type=password]",PASS); await p.click("button[type=submit]");
  for (let i=0;i<20&&!(await p.locator(".bw-nav-item").count());i++){const s=p.locator("form button[type=submit]").first(); if(await s.count()&&await s.isEnabled()) await s.click().catch(()=>{}); await p.waitForTimeout(500);}
  check(vw,"signed in to the app shell",await p.locator(".bw-nav-item").count()===7); await p.waitForTimeout(1500);
  const tabs=p.locator(".bw-nav-item");
  for (let i=0;i<7;i++){ await tabs.nth(i).click(); const box=await tabs.nth(i).boundingBox(); check(vw,`tab ${i+1} reachable and active`,box&&box.x>=0&&box.x+box.width<=w+1&&(await tabs.nth(i).getAttribute("aria-current"))==="page"); }
  // Dashboard period picker changes figures without errors.
  await tabs.nth(0).click(); await p.waitForSelector(".bw-segmented button",{timeout:20000}); await p.locator(".bw-segmented button").nth(1).click(); check(vw,"period picker selects",(await p.locator(".bw-segmented button").nth(1).getAttribute("aria-pressed"))==="true");
  // Transactions: change a category in memory, then exclude/include.
  await tabs.nth(1).click(); const sel=p.locator(".bw-tx-table select").first(); const before=await sel.inputValue();
  await sel.selectOption("Shopping"); await p.waitForTimeout(400); check(vw,"category correction applies",(await p.locator(".bw-tx-table select").first().inputValue())==="Shopping");
  await p.locator(".bw-tx-table select").first().selectOption(before); await p.waitForTimeout(300);
  // Import: preview appears for the CSV and can be cancelled.
  await tabs.nth(3).click(); await p.setInputFiles(".bw-dropzone input[type=file]",path.join(__dirname,"sample.csv")); await p.waitForTimeout(1200);
  const pv=await p.evaluate(()=>({universal:!!document.querySelector(".bw-universal"),review:!!document.querySelector(".bw-review-table"),msg:document.querySelector(".bw-message")?.innerText,heads:[...document.querySelectorAll(".bw-main h2,.bw-main h3")].map(h=>h.innerText).slice(0,6)}));
  check(vw,"duplicate statement is rejected with a clear message",/already imported/.test(pv.msg||""),pv.msg);
  await p.setInputFiles(".bw-dropzone input[type=file]",path.join(__dirname,"sample-b.csv")); await p.waitForTimeout(1200);
  check(vw,"import preview opens for a new file",await p.locator(".bw-universal").count());
  const cancel=p.locator("button",{hasText:/^Cancel$/}).first(); if(await cancel.count()) await cancel.click(); await p.waitForTimeout(300);
  check(vw,"import preview cancels back to the drop zone",await p.locator(".bw-dropzone").isVisible());
  check(vw,"drop zone shows drag-over state",await p.evaluate(()=>{const z=document.querySelector(".bw-dropzone");z.dispatchEvent(new DragEvent("dragenter",{bubbles:true}));return new Promise(r=>setTimeout(()=>r(z.classList.contains("is-dragover")),100));}));
  // Data: open a local database's delete confirmation and cancel it.
  await tabs.nth(5).click(); const del=p.locator(".bw-db-list button.bw-button-danger-outline, .bw-db-card button.bw-button-danger-outline").last();
  if (await del.count()) { await del.click(); check(vw,"delete confirmation asks for the typed word",await p.locator(".bw-confirm input").isVisible());
    const confirmBtn=p.locator(".bw-confirm .bw-button-danger"); check(vw,"delete stays disabled until the word is typed",await confirmBtn.isDisabled());
    await p.locator(".bw-confirm button",{hasText:/Cancel/}).first().click(); check(vw,"delete confirmation cancels",!(await p.locator(".bw-confirm").count())); }
  // Settings: theme radio and (desktop) collapse.
  await tabs.nth(6).click(); await p.locator("[role=radio]",{hasText:"Dark"}).click();
  check(vw,"dark theme from Settings",await p.evaluate(()=>document.documentElement.dataset.theme==="dark"&&getComputedStyle(document.body).backgroundColor==="rgb(23, 19, 28)"));
  await p.locator("[role=radio]",{hasText:"Match system"}).click(); check(vw,"system theme restores",await p.evaluate(()=>!document.documentElement.dataset.theme));
  if (vw==="desktop"){ await p.locator(".bw-nav-toggle").click(); await p.waitForTimeout(300); check(vw,"sidebar collapses",(await p.locator(".bw-nav").boundingBox()).width<=72);
    await p.reload(); await p.waitForSelector(".bw-nav-item",{timeout:15000}).catch(()=>{}); check(vw,"collapse remembered after reload",await p.locator(".bw-app.is-collapsed").count());
    await p.locator(".bw-nav-toggle").click(); }
  check(vw,"no page errors",errs.length===0,errs.join("; "));
  const foreign=net.filter(u=>!/\/\/localhost:(1420|3000)\//.test(u)); check(vw,"no requests outside the app and BillieWeather server",foreign.length===0,foreign.slice(0,5).join(", "));
  const uploads=net.filter(u=>/^POST .*finance\/statements/.test(u)); check(vw,"no statement uploaded to the cloud",uploads.length===0,uploads.join(", "));
  await ctx.close();
}
await b.close(); fs.writeFileSync(path.join(__dirname,"qa","app-interactions.json"),JSON.stringify(results,null,1));
const failed=results.filter(r=>!r.ok); console.log(`${results.length} checks, ${failed.length} failed`); for(const f of failed) console.log("FAIL",f.vw,f.name,f.detail);
})().catch(e=>{console.error(e);process.exit(1)});
