// @vitest-environment jsdom
// Local database metadata for the website: off by default, allowlisted, deduplicated, ordered,
// and removals are queued and retried until the server confirms.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importFile } from "../src/services/importFile";
import { REPORT_FIELDS } from "../src/services/localReport";
import { queueDelete, reportAll, reportingStatus, setReporting, deviceId, type ReportContext } from "../src/services/reporting";
import { API_ORIGIN } from "../src/services/account";
import { fixtureBytes, newStore } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Call = { method: string; url: string; body: Record<string, unknown> | null };
let calls: Call[];
let online: boolean;
let status: number;

beforeEach(() => {
  localStorage.clear();
  calls = [];
  online = true;
  status = 200;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (!online) throw new TypeError("offline");
    calls.push({ method: init?.method ?? "GET", url: String(input).replace(`${API_ORIGIN}/api/client/v1/devices`, ""), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ status: "applied" }), { status });
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(account = "jyun@example.com") {
  const first = await newStore();
  await first.store.setDatabaseName("Personal Finance 2026");
  await importFile(first.store, fixtureBytes("basic-amount.csv"), "SECRET-FILE.csv", "USD");
  const second = await newStore();
  await second.store.setDatabaseName("Work");
  const ctx: ReportContext = {
    account, token: "tok", deviceName: "Jyun's MacBook", openedAt: "2026-11-09T14:25:00.000Z",
    databases: [{ id: "1", store: first.store }, { id: "2", store: second.store }],
  };
  return { ctx, first: first.store, second: second.store };
}

describe("metadata reporting", () => {
  it("is off by default: nothing is sent", async () => {
    const { ctx } = await setup();
    expect(reportingStatus(ctx.account)).toEqual({ enabled: false, pendingRemoval: false, removalConfirmed: false });
    await reportAll(ctx);
    expect(calls).toEqual([]);
  });

  it("when switched on, sends one request per database containing only the allowlisted metadata", async () => {
    const { ctx } = await setup();
    await setReporting(ctx, true);
    expect(calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
    const device = deviceId();
    expect(device).toMatch(UUID);
    for (const call of calls) {
      const [, d, , db] = call.url.split("/");
      expect(d).toBe(device);
      expect(db).toMatch(UUID);
      expect(Object.keys(call.body!)).toEqual(["database"]);
      expect(Object.keys(call.body!.database as object)).toEqual([...REPORT_FIELDS]);
    }
    const body = calls[0].body!.database as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Personal Finance 2026", device_name: "Jyun's MacBook", statement_count: 1, transaction_count: 9, rule_count: 0, opened_at: "2026-11-09T14:25:00.000Z" });
    expect(body.size_bytes).toBeGreaterThan(0);
    expect(body.period_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // No financial content, file names, paths or identifiers derived from them.
    const everything = JSON.stringify(calls) + JSON.stringify(Object.fromEntries(Object.entries(localStorage)));
    for (const secret of ["SECRET-FILE", "basic-amount", "billieweather.db", "/Users/", "Library", "ZED"]) expect(JSON.stringify(calls)).not.toContain(secret);
    expect(everything).not.toMatch(/amount_cents|description/);
  });

  it("sends nothing again until something changes; a rename keeps the same database id", async () => {
    const { ctx, first } = await setup();
    await setReporting(ctx, true);
    const ids = calls.map((c) => c.url.split("/")[3]);
    calls.length = 0;
    await reportAll(ctx);
    await reportAll(ctx);
    expect(calls).toEqual([]);

    await first.setDatabaseName("Renamed");
    await reportAll(ctx);
    expect(calls.length).toBe(1);
    expect(calls[0].url.split("/")[3]).toBe(ids[0]);
    expect((calls[0].body!.database as { name: string }).name).toBe("Renamed");
    // Newer information always carries a higher sequence number than older.
    expect(calls[0].body && (calls[0].body.database as { sequence: number }).sequence).toBeGreaterThan(0);
  });

  it("sequence numbers only go up", async () => {
    const { ctx, first } = await setup();
    await setReporting(ctx, true);
    await first.setDatabaseName("A");
    await reportAll(ctx);
    await first.setDatabaseName("B");
    await reportAll(ctx);
    const seq = calls.map((c) => (c.body!.database as { sequence: number }).sequence);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(new Set(seq).size).toBe(seq.length);
  });

  it("does not report when signed out, and keeps working offline", async () => {
    const { ctx } = await setup();
    await setReporting({ ...ctx, token: null }, true);
    expect(calls).toEqual([]);
    online = false;
    await expect(reportAll(ctx)).resolves.toBeUndefined();
  });

  it("a deleted database is removed on the server; offline, the removal waits and is retried with the same sequence", async () => {
    const { ctx, first } = await setup();
    await setReporting(ctx, true);
    const id = await first.reportId();
    calls.length = 0;

    online = false;
    queueDelete(ctx.account, id);
    await reportAll({ ...ctx, databases: [ctx.databases[1]] });
    expect(calls).toEqual([]);
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(true);

    online = true;
    await reportAll({ ...ctx, databases: [ctx.databases[1]] });
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(calls[0].url).toMatch(new RegExp(`^/${deviceId()}/databases/${id}\\?sequence=\\d+$`));
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(false);
    calls.length = 0;
    await reportAll({ ...ctx, databases: [ctx.databases[1]] });
    expect(calls).toEqual([]); // not repeated once confirmed
  });

  it("a removal is sent before any newer report, so a deleted database cannot reappear", async () => {
    const { ctx, first, second } = await setup();
    await setReporting(ctx, true);
    const id = await first.reportId();
    calls.length = 0;
    queueDelete(ctx.account, id);
    await second.setDatabaseName("Work 2");
    await reportAll({ ...ctx, databases: [ctx.databases[1]] });
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "PUT"]);
    const deleteSeq = Number(/sequence=(\d+)/.exec(calls[0].url)![1]);
    expect((calls[1].body!.database as { sequence: number }).sequence).toBeGreaterThan(deleteSeq);
  });

  it("deleting a database that was never reported sends nothing", async () => {
    const { ctx } = await setup();
    queueDelete(ctx.account, "7b1d3c52-9a41-4f0e-8a77-2d6f0c9b1e33");
    await reportAll(ctx);
    expect(calls).toEqual([]);
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(false);
  });

  it("switching off asks the server to forget this device; until it confirms, the removal is pending and ordinary reporting stays off", async () => {
    const { ctx, first } = await setup();
    await setReporting(ctx, true);
    calls.length = 0;

    online = false;
    await setReporting(ctx, false);
    expect(reportingStatus(ctx.account)).toEqual({ enabled: false, pendingRemoval: true, removalConfirmed: false });
    await first.setDatabaseName("Changed while off");
    await reportAll(ctx);
    expect(calls).toEqual([]);

    online = true;
    await reportAll(ctx);
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(calls[0].url).toMatch(new RegExp(`^/${deviceId()}\\?sequence=\\d+$`));
    expect(reportingStatus(ctx.account)).toEqual({ enabled: false, pendingRemoval: false, removalConfirmed: true });
    calls.length = 0;
    await reportAll(ctx);
    expect(calls).toEqual([]); // still off: nothing is silently resumed
  });

  it("turning it back on after a pending removal sends the removal first, then reports again", async () => {
    const { ctx } = await setup();
    await setReporting(ctx, true);
    online = false;
    await setReporting(ctx, false);
    online = true;
    calls.length = 0;
    await setReporting(ctx, true);
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "PUT", "PUT"]);
    expect(reportingStatus(ctx.account)).toMatchObject({ enabled: true, pendingRemoval: false });
  });

  it("settings and queued removals belong to one account", async () => {
    const { ctx } = await setup("one@example.com");
    await setReporting(ctx, true);
    online = false;
    await setReporting(ctx, false);
    online = true;
    calls.length = 0;
    const other = { ...ctx, account: "two@example.com" };
    expect(reportingStatus(other.account)).toEqual({ enabled: false, pendingRemoval: false, removalConfirmed: false });
    await reportAll(other);
    expect(calls).toEqual([]);
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(true);
  });

  it("a request the server refuses for good is dropped instead of blocking the queue forever", async () => {
    const { ctx } = await setup();
    await setReporting(ctx, true);
    status = 422;
    await setReporting(ctx, false);
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(false);
  });

  it("a temporary server error keeps the removal queued", async () => {
    const { ctx } = await setup();
    await setReporting(ctx, true);
    status = 503;
    await setReporting(ctx, false);
    expect(reportingStatus(ctx.account)).toMatchObject({ pendingRemoval: true, removalConfirmed: false });
  });

  it("database ids are random, stable across renames, and new after a database is wiped", async () => {
    const { first } = await setup();
    expect(await first.peekReportId()).toBeNull();
    const id = await first.reportId();
    expect(id).toMatch(UUID);
    await first.setDatabaseName("Another name");
    expect(await first.reportId()).toBe(id);
    await first.deleteAllData({ forgetName: true });
    expect(await first.peekReportId()).toBeNull();
    expect(await first.reportId()).not.toBe(id);
  });

  it("the summary holds counts and dates only", async () => {
    const { first } = await setup();
    const summary = await first.reportSummary();
    expect(Object.keys(summary).sort()).toEqual(["modifiedAt", "name", "periodEnd", "periodStart", "rules", "sizeBytes", "statements", "transactions"]);
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });

  it("there is no background timer anywhere in reporting", () => {
    for (const file of ["reporting.ts", "localReport.ts"]) {
      expect(readFileSync(join(__dirname, "../src/services", file), "utf8")).not.toMatch(/setInterval|setTimeout|requestIdleCallback|serviceWorker|periodicSync/);
    }
  });
});
