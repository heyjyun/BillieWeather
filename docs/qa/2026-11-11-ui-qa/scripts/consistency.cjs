const fs=require("fs"),path=require("path");const {browser}=require("./audit-lib.cjs");
const PASS=fs.readFileSync(path.join(__dirname,"preview-pass.txt"),"utf8").trim();
const probe=(sel)=>({
  sidebarBg:[sel.sidebar,"backgroundColor"], navActiveBg:[sel.active,"backgroundColor"], navActiveColor:[sel.active,"color"], navHeight:[sel.active,"height"],
  primaryBg:[".bw-button-dark","backgroundColor"], primaryRadius:[".bw-button-dark","borderRadius"], primaryText:[".bw-button-dark","color"],
  pageBg:["body","backgroundColor"], cardBg:[".bw-panel","backgroundColor"], cardBorder:[".bw-panel","borderTopColor"], cardRadius:[".bw-panel","borderTopLeftRadius"], cardShadow:[".bw-panel","boxShadow"],
  metricValueSize:[sel.metricValue,"fontSize"], metricLabelColor:[sel.metricLabel,"color"], h1Size:["h1","fontSize"], eyebrowColor:[".bw-eyebrow","color"], bodyFont:["body","fontFamily"], textColor:["h1","color"],
  balanceTileBg:[sel.balance,"backgroundColor"], positiveColor:[sel.positive,"color"], brandMarkBg:[".bw-brand-mark","backgroundColor"],
});
const read=(page,spec)=>page.evaluate((spec)=>Object.fromEntries(Object.entries(spec).map(([k,[s,prop]])=>{const el=document.querySelector(s);return [k,el?getComputedStyle(el)[prop]:"(missing)"]})),spec);
(async()=>{const b=await browser();const out={};
for (const theme of ["light","dark"]) {
  const ctx=await b.newContext({viewport:{width:1280,height:860},colorScheme:theme});const p=await ctx.newPage();
  await p.goto("http://localhost:3000/users/sign_in?locale=en");await p.fill("#user_email","design-preview@billieweather.test");await p.fill("#user_password",PASS);
  await Promise.all([p.waitForNavigation(),p.click("form [type=submit]")]);await p.goto("http://localhost:3000/app");
  const web=await read(p,probe({sidebar:".bw-sidebar",active:".bw-nav-link.is-active",metricValue:".bw-metric > strong",metricLabel:".bw-metric > span",balance:".bw-metric-mint",positive:".bw-metric .bw-positive"}));
  await p.goto("http://localhost:1420/");await p.waitForSelector(".bw-login-card");await p.fill("input[type=email]","design-preview@billieweather.test");await p.fill("input[type=password]",PASS);await p.click("button[type=submit]");
  for(let i=0;i<20&&!(await p.locator(".bw-nav-item").count());i++){const s=p.locator("form button[type=submit]").first();if(await s.count()&&await s.isEnabled())await s.click().catch(()=>{});await p.waitForTimeout(500);}
  await p.waitForSelector(".bw-metric",{timeout:20000});
  const app=await read(p,probe({sidebar:".bw-nav",active:".bw-nav-item.is-active",metricValue:".bw-metric > strong",metricLabel:".bw-metric > span",balance:".bw-metric-accent",positive:".bw-metric .bw-positive"}));
  // primary button only exists on some app pages: use Import page.
  await p.locator(".bw-nav-item").nth(3).click(); Object.assign(app, Object.fromEntries(Object.entries(await read(p,{primaryBg:[".bw-button-dark","backgroundColor"],primaryRadius:[".bw-button-dark","borderRadius"],primaryText:[".bw-button-dark","color"]})).filter(([,v])=>v!=="(missing)")));
  out[theme]=Object.keys(web).map(k=>({token:k,web:web[k],app:app[k],same:web[k]===app[k]}));
  await ctx.close();}
await b.close();fs.writeFileSync(path.join(__dirname,"qa","consistency.json"),JSON.stringify(out,null,1));
for(const t in out){console.log("==",t);for(const r of out[t])console.log((r.same?"  same ":"  DIFF ")+r.token.padEnd(18),r.same?r.web.slice(0,60):`web=${r.web.slice(0,50)} | app=${r.app.slice(0,50)}`);}
})().catch(e=>{console.error(e);process.exit(1)});
