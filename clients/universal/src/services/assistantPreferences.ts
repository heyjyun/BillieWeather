import type { AssistantState, Feedback } from "../../../../public/next-steps.mjs";
import { API_ORIGIN } from "./account";
import type { FinanceStore, SqlStatement } from "./store";

type Value = boolean | Feedback;
type Pending = {value: Value; expected: Value | null};
const portable = new Set(["enabled","organization","planning","account","import","classify","duplicates","matches","budget","forecast","report"]);
function wireValue(key: string, input: unknown): Value | null {
  if (["enabled","organization","planning"].includes(key)) return typeof input === "boolean" ? input : null;
  if (!input || typeof input !== "object" || !("status" in input)) return null;
  if ((input.status === "deferred" || input.status === "completed") && "until" in input && Number.isSafeInteger(input.until)) return {status:input.status,until:Number(input.until)};
  if (["accepted","completed","dismissed","invalidated"].includes(String(input.status))) return {status:input.status as Feedback["status"]};
  return null;
}
const prefix = "assistant.state.";
const pendingPrefix = "assistant.pending.";
const remotePrefix = "assistant.remote.";
const upsert = (key: string, value: unknown): SqlStatement => ({
  sql: "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [key,JSON.stringify(value)],
});
export async function assistantState(store: FinanceStore): Promise<AssistantState> {
  const rows = await store.sql.select<{key:string;value:string}>("SELECT key,value FROM settings WHERE key LIKE 'assistant.state.%'");
  return Object.fromEntries(rows.map(row => [row.key.slice(prefix.length), JSON.parse(row.value)]));
}
export async function saveAssistantChoice(store: FinanceStore, key: string, value: Value, expectedLocal?: Feedback) {
  if (expectedLocal && JSON.stringify((await assistantState(store))[key]) !== JSON.stringify(expectedLocal)) return;
  const changes = [upsert(prefix + key, value)];
  if (portable.has(key) && (typeof value === "boolean" || ["deferred","dismissed"].includes(value.status))) {
    const expected = JSON.parse(await store.ledger.setting(remotePrefix + key) ?? "null") as Value | null;
    changes.push(upsert(pendingPrefix + key, {value,expected}));
  }
  await store.sql.transaction(changes);
}

const flights = new WeakMap<FinanceStore, {again:boolean; done:Promise<void>}>();
export function syncAssistantChoices(store: FinanceStore, token: string): Promise<void> {
  const running = flights.get(store);
  if (running) {
    running.again = true;
    return running.done;
  }
  const job = {again:false,done:Promise.resolve()};
  flights.set(store,job);
  job.done = (async () => {
    do {
      job.again = false;
      await exchange(store,token);
    } while (job.again);
  })().finally(() => flights.delete(store));
  return job.done;
}
async function exchange(store: FinanceStore, token: string) {
  const url = API_ORIGIN + "/api/client/v1/assistant_preferences";
  const request = async (method: string, body?: unknown): Promise<AssistantState> => {
    const response = await fetch(url, { method, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(8000),
      headers: {Authorization: "Bearer " + token, "Content-Type":"application/json", Accept:"application/json"}, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error("sync_unavailable");
    return response.json();
  };
  const queue = await store.sql.select<{key:string;value:string}>("SELECT key,value FROM settings WHERE key LIKE 'assistant.pending.%'");
  let remote = await request("GET");
  for (const row of queue) {
    const key = row.key.slice(pendingPrefix.length);
    if (!portable.has(key)) continue;
    const item = JSON.parse(row.value) as Pending;
    const value = wireValue(key, item.value);
    if (value === null) continue;
    remote = await request("PUT", {key, value, expected: wireValue(key, item.expected)});
    // A newer offline decision may have arrived while this request was in flight.
    await store.sql.transaction([
      {sql:"DELETE FROM settings WHERE key=? AND value=?", params:[row.key,row.value]},
      upsert(remotePrefix + key,remote[key] ?? null),
      {sql:"UPDATE settings SET value=json_set(value,'$.expected',json(?)) WHERE key=?", params:[JSON.stringify(remote[key] ?? null),row.key]},
    ]);
  }
  const changes: SqlStatement[] = [];
  for (const key of portable) {
    const value = remote[key];
    if (value === undefined) continue;
    changes.push(upsert(remotePrefix + key,value), {sql:"INSERT INTO settings(key,value) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM settings WHERE key=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      params:[prefix+key,JSON.stringify(value),pendingPrefix+key]});
  }
  if (changes.length) await store.sql.transaction(changes);
}
