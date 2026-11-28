import { proposeAccounts } from "../../../public/account-capture.mjs";
import { nextSteps, resolvedChoices, selectSuggestion, type NextFacts } from "../../../public/next-steps.mjs";
import { newStore } from "./helpers";
import { assistantState, syncAssistantChoices, saveAssistantChoice } from "../src/services/assistantPreferences";

const facts: NextFacts = {accounts:[], transactions:0, statements:0, unclassified:0, duplicates:0, matches:0, budgets:0, months:{}, scheduled:[],
  currency:"USD", forecastReady:false,recent:[],available:["account","import","discover","classify","report","reconcile","budget","recurring"]};
it("extracts separate proposals, preserves uncertainty, and ignores non-current credit amounts", () => {
  expect(proposeAccounts("Chase checking ••••1234\nCapital One credit card ••••4321\nCurrent balance $999",true)).toEqual([]);
  const proposals = proposeAccounts("I have a Chase checking account with $3,000, a Chase credit card with $500 outstanding, an Alipay wallet, and a WeChat wallet.");
  expect(proposals.map(p => [p.institution,p.type,p.amount,p.currency])).toEqual([
    ["Chase","checking","3000",""],["Chase","credit_card","500",""],["Alipay","payment_app","",""],["WeChat","payment_app","",""]]);
  expect(proposeAccounts("招商银行储蓄卡余额人民币200元、支付宝钱包")).toHaveLength(2);
  expect(proposeAccounts("Chase credit card\nCredit limit $1,000\nStatement balance $80",true)[0].amount).toBe("");
  expect(proposeAccounts("Chase credit card ••••4567\nCurrent balance $40\nAvailable credit $960",true)[0]).toMatchObject({amount:"40",last4:"4567"});
});
it.each([
  ["en","Chase checking USD 125","Chase","checking","125"],
  ["zh-CN","招商银行储蓄账户余额100元","招商银行","savings","100"],
  ["zh-TW","微信錢包餘額200元","微信","payment_app","200"],
  ["ja","みずほ銀行 普通預金 JPY 800","みずほ銀行","savings","800"],
  ["ko","신한은행 저축 USD 35","신한은행","savings","35"],
  ["es","cuenta corriente BBVA EUR 80","BBVA","checking","80"],
])("recognizes an account in %s",(_locale,text,institution,type,amount)=>{
  expect(proposeAccounts(text)).toMatchObject([{institution,type,amount}]);
});
it("uses book-scoped feedback, honest evidence, and fresh conditions", async () => {
  const {store} = await newStore();
  expect(nextSteps(facts,"dashboard")[0].kind).toBe("account");
  await saveAssistantChoice(store,"account",{status:"dismissed"});
  expect(nextSteps(facts,"dashboard",await assistantState(store))).toEqual([]);
  const formed = {...facts,accounts:[{id:3,name:"Checking",institution:"Chase",pending:false,archived:false}]};
  expect(nextSteps(formed,"accounts")[0].kind).toBe("import");
  const rows = [1,2].map(id=>({id,date:"2026-10-0"+id,description:"Capital One payment",kind:"card_payment",cents:-300}));
  expect(nextSteps({...formed,transactions:2,recent:rows},"accounts")[0]).toMatchObject({kind:"discover",target:"Capital One"});
  expect(nextSteps({...formed,transactions:2,recent:rows.map(r=>({...r,kind:"expense"}))},"accounts")).toEqual([]);
  expect(nextSteps({...formed,transactions:2,unclassified:1},"transactions",{classify:{status:"deferred",until:200}},100)).toEqual([]);
  expect(nextSteps({...formed,transactions:2,unclassified:1},"transactions",{classify:{status:"deferred",until:200}},201)[0].kind).toBe("classify");
});
it("commits a reviewed local batch once and matches its later statement identity",async()=>{
  const {store} = await newStore();
  const batch = {key:"e618f129-5ec0-4385-a343-020cc4e97553",source:"text" as const};
  const rows = [{name:"Custom card",type:"credit_card" as const,currency:"USD",institution:"Chase",last4:"4321",openingBalanceCents:-50000,openingBalanceOn:"2026-10-30"},
    {name:"Wallet",type:"payment_app" as const,currency:"USD",openingBalanceCents:null}];
  const created = await store.ledger.createAccounts(rows,"user",batch);
  expect(await store.ledger.createAccounts(rows,"user",batch)).toEqual(created);
  expect(created.map(a => [a.balanceCents,a.openingBalanceSource])).toEqual([[-50000,"user"],[0,"unknown"]]);
  expect((await store.ledger.accountStatementsForImport({key:"chase|4321|credit_card",currency:"USD"})).statements).toEqual([]);
  await expect(store.ledger.createAccounts([rows[0],rows[0]])).rejects.toThrow();
  expect(await store.ledger.accounts()).toHaveLength(2);
  await store.ledger.adjustBalance(created[1].id,0,"2026-10-30");
  expect((await store.ledger.account(created[1].id)).openingBalanceSource).toBe("user");
});


it("resolves a verified change, invalidates vanished evidence, and permits new work",()=>{
  const next = {...facts,accounts:[{id:3,name:"Checking",institution:"Chase",pending:false,archived:false}],transactions:3};
  expect(resolvedChoices(next,{account:{status:"accepted"},"reconcile:8":{status:"accepted"}})).toEqual([
    ["account",{status:"completed"}],["reconcile:8",{status:"invalidated"}]]);
  const suggestions = nextSteps({...next,unclassified:3},"assistant",{classify:{status:"completed"}});
  expect(selectSuggestion("帮我分类",suggestions).map(item=>item.kind)).toEqual(["classify"]);
  expect(nextSteps({...next,unclassified:3},"assistant",{organization:false})).toEqual([]);
});

it("sends only cross-book choices, keeps financial evidence local and retries after offline use",async()=>{
  const {store} = await newStore();
  await saveAssistantChoice(store,"reconcile:48",{status:"dismissed"});
  await saveAssistantChoice(store,"account",{status:"accepted"});
  await saveAssistantChoice(store,"enabled",false);
  const transport = vi.spyOn(globalThis,"fetch").mockRejectedValueOnce(new Error("offline"));
  try {
    await expect(syncAssistantChoices(store,"synthetic")).rejects.toThrow("offline");
    expect(await assistantState(store)).toMatchObject({enabled:false,"reconcile:48":{status:"dismissed"}});
    transport.mockImplementation(async (_url,init) => new Response(JSON.stringify(init?.method === "PUT" ? {enabled:false} : {})));
    await syncAssistantChoices(store,"synthetic");
    const writes = transport.mock.calls.filter(([,init])=>init?.method === "PUT");
    expect(writes.map(([,init])=>JSON.parse(String(init?.body)))).toEqual([{key:"enabled",value:false,expected:null}]);
  } finally { transport.mockRestore(); }
});

it("balances on both sides of a confirmed date preserve pre-snapshot history",async()=>{
  const {store} = await newStore();
  const acc = await store.ledger.createAccount({name:"Cash",type:"cash",currency:"USD",openingBalanceCents:5000,openingBalanceOn:"2026-09-05",balanceSnapshot:true});
  for (const occurredOn of ["2026-09-04","2026-09-06"]) await store.ledger.createEntry({kind:"expense",amountCents:500,occurredOn,accountId:acc.id,description:"Synthetic",category:"Shopping"});
  expect((await store.ledger.account(acc.id)).balanceCents).toBe(4500);
  await store.ledger.adjustBalance(acc.id,4000,"2026-09-05");
  expect((await store.ledger.account(acc.id)).balanceCents).toBe(3500);
  await expect(store.ledger.adjustBalance(acc.id,100,"2026-09-04")).rejects.toThrow();
});

it("compares spending with recorded months and the person's own budget",()=>{
  const book = {...facts,transactions:10,budgets:1,remaining:-2000,months:{"2026-06":9000,"2026-07":10000,"2026-08":11000,"2026-09":20000}};
  const options = nextSteps(book,"budgets");
  expect(options[0]).toMatchObject({label:"overBudget",detail:"USD 20.00"});
  expect(options.find(item=>item.kind === "report")).toMatchObject({label:"spendingChange",detail:expect.stringContaining("USD 100.00")});
});
