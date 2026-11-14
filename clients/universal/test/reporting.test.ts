// @vitest-environment jsdom
// Local database metadata for the website: automatic for a signed-in person, allowlisted,
// deduplicated, ordered, and removals are queued and retried until the server confirms.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importFile } from "../src/services/importFile";
import { REPORT_FIELDS } from "../src/services/localReport";
import { metadataUpdatedAt, queueDelete, reportAll, reportingIdentity, reportingStatus, type ReportContext } from "../src/services/reporting";
import * as platform from "../src/services/platform";
import { API_ORIGIN } from "../src/services/account";
import { fixtureBytes, newStore } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The stable id the native app keeps in device-identity.json (see src-tauri/src/identity.rs).
const DEVICE = "754309e7-4ba6-4336-9347-5eb71ddbd657";
const deviceId = () => DEVICE;
vi.mock("../src/services/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/platform")>()),
  deviceIdentity: vi.fn(async (candidate: string) => ({ deviceId: candidate, platform: "macos", reportable: true })),
}));
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
    account, token: "tok", identity: { deviceId: DEVICE, platform: "macos" }, deviceName: "Jyun's MacBook", openedAt: "2026-11-09T14:25:00.000Z",
    databases: [{ id: "1", store: first.store }, { id: "2", store: second.store }],
  };
  return { ctx, first: first.store, second: second.store };
}

describe("metadata reporting", () => {
  it("reopening the app 20 times always targets the same device and database (one card)", async () => {
    const { ctx, first } = await setup();
    for (let launch = 0; launch < 20; launch += 1) {
      localStorage.removeItem("billie.report.sent"); // force a request on every launch
      await reportAll({ ...ctx, openedAt: new Date(Date.UTC(2026, 10, 9, 14, launch)).toISOString(), databases: [ctx.databases[0]] });
    }
    expect(calls.length).toBe(20);
    expect(new Set(calls.map((c) => c.url)).size).toBe(1);
    expect(calls[0].url).toBe(`/${DEVICE}/databases/${await first.reportId()}`);
  });

  it("a browser preview, QA or debug build (no identity) never reports anything", async () => {
    const { ctx } = await setup();
    await reportAll({ ...ctx, identity: null });
    expect(calls).toEqual([]);
    queueDelete(ctx.account, "11111111-2222-4333-8444-555555555555");
    await reportAll({ ...ctx, identity: null });
    expect(calls).toEqual([]);
  });

  it("a database that has no name yet is not reported and gets no id (never 'Unnamed database')", async () => {
    const { ctx } = await setup();
    const unnamed = await newStore();
    await reportAll({ ...ctx, databases: [{ id: "3", store: unnamed.store }] });
    expect(calls).toEqual([]);
    expect(await unnamed.store.peekReportId()).toBeNull();
    expect(JSON.stringify(calls)).not.toContain("Unnamed database");
  });

  it("two different databases on one device keep two different ids and are never combined", async () => {
    const { ctx, first, second } = await setup();
    await reportAll(ctx);
    const ids = calls.map((c) => c.url.split("/")[3]);
    expect(ids).toEqual([await first.reportId(), await second.reportId()]);
    expect(new Set(ids).size).toBe(2);
    expect(calls.map((c) => (c.body!.database as { transaction_count: number }).transaction_count)).toEqual([9, 0]);
  });

  it("reports the last explicit Sync Now only, and nothing when there was none", async () => {
    const { ctx, first } = await setup();
    await reportAll(ctx);
    expect((calls[0].body!.database as { synced_at: string | null }).synced_at).toBeNull();
    calls.length = 0;
    await first.markSynced();
    await reportAll(ctx);
    expect((calls[0].body!.database as { synced_at: string | null }).synced_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("the identity adopts the id an older version kept in WebView storage, and only reports when the native app allows it", async () => {
    const mocked = vi.mocked(platform.deviceIdentity);
    localStorage.setItem("billie.report.device", JSON.stringify(DEVICE));
    expect(await reportingIdentity()).toEqual({ deviceId: DEVICE, platform: "macos" });
    expect(mocked).toHaveBeenLastCalledWith(DEVICE);
    localStorage.removeItem("billie.report.device");
    await reportingIdentity();
    expect(mocked.mock.lastCall![0]).toMatch(UUID);
    expect(localStorage.getItem("billie.report.device")).toBeNull(); // never written to WebView storage any more
    mocked.mockResolvedValueOnce({ deviceId: DEVICE, platform: "macos", reportable: false });
    expect(await reportingIdentity()).toBeNull();
    mocked.mockResolvedValueOnce(null);
    expect(await reportingIdentity()).toBeNull();
  });

  it("is automatic: there is no switch, and a signed-in app reports every database", async () => {
    const { ctx } = await setup();
    await reportAll(ctx);
    expect(calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
    expect(Object.keys(reportingStatus(ctx.account)).sort()).toEqual(["lastUpdatedAt", "pendingRemoval"]);
    const source = readFileSync(join(__dirname, "../src/services/reporting.ts"), "utf8");
    expect(source).not.toMatch(/setReporting|billie\.report\.enabled/);
  });

  it("sends one request per database containing only the allowlisted metadata", async () => {
    const { ctx } = await setup();
    await reportAll(ctx);
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
    expect(body).toMatchObject({ name: "Personal Finance 2026", device_name: "Jyun's MacBook", platform: "macos", synced_at: null, statement_count: 1, transaction_count: 9, rule_count: 0, opened_at: "2026-11-09T14:25:00.000Z" });
    expect(body.size_bytes).toBeGreaterThan(0);
    expect(body.period_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const secret of ["SECRET-FILE", "basic-amount", "billieweather.db", "/Users/", "Library", "ZED"]) expect(JSON.stringify(calls)).not.toContain(secret);
    expect(JSON.stringify(calls)).not.toMatch(/amount_cents|description/);
  });

  it("sends nothing again until something changes; a rename keeps the same database id", async () => {
    const { ctx, first } = await setup();
    await reportAll(ctx);
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
  });

  it("sequence numbers only go up", async () => {
    const { ctx, first } = await setup();
    await reportAll(ctx);
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
    await reportAll({ ...ctx, token: null });
    expect(calls).toEqual([]);
    online = false;
    await expect(reportAll(ctx)).resolves.toBeUndefined();
    expect(reportingStatus(ctx.account).lastUpdatedAt).toBeNull();
    online = true;
    await reportAll(ctx);
    expect(calls.length).toBe(2); // sent once back online
  });

  it("a deleted database is removed on the server; offline, the removal waits and is retried with the same sequence", async () => {
    const { ctx, first } = await setup();
    await reportAll(ctx);
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
    expect(calls).toEqual([]);
  });

  it("a removal is sent before any newer report, so a deleted database cannot reappear", async () => {
    const { ctx, first, second } = await setup();
    await reportAll(ctx);
    const id = await first.reportId();
    calls.length = 0;
    queueDelete(ctx.account, id);
    await second.setDatabaseName("Work 2");
    await reportAll({ ...ctx, databases: [ctx.databases[1]] });
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "PUT"]);
    const deleteSeq = Number(/sequence=(\d+)/.exec(calls[0].url)![1]);
    expect((calls[1].body!.database as { sequence: number }).sequence).toBeGreaterThan(deleteSeq);
  });

  it("a database that never got an id sends no removal", async () => {
    const { ctx } = await setup();
    queueDelete(ctx.account, null);
    await reportAll({ ...ctx, databases: [] });
    expect(calls).toEqual([]);
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(false);
  });

  it("queued removals belong to one account", async () => {
    const { ctx, first } = await setup("one@example.com");
    await reportAll(ctx);
    online = false;
    queueDelete(ctx.account, await first.reportId());
    online = true;
    calls.length = 0;
    const other = { ...ctx, account: "two@example.com", databases: [] };
    expect(reportingStatus(other.account).pendingRemoval).toBe(false);
    await reportAll(other);
    expect(calls).toEqual([]);
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(true);
  });

  it("a removal the server refuses for good is dropped; a temporary error keeps it queued", async () => {
    const { ctx, first, second } = await setup();
    await reportAll(ctx);
    status = 503;
    queueDelete(ctx.account, await first.reportId());
    await reportAll({ ...ctx, databases: [] });
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(true);
    status = 422;
    await reportAll({ ...ctx, databases: [] });
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(false);
    status = 200;
    queueDelete(ctx.account, await second.reportId());
    await reportAll({ ...ctx, databases: [] });
    expect(reportingStatus(ctx.account).pendingRemoval).toBe(false);
  });

  it("a stop-sharing request queued by an older version is still sent", async () => {
    const { ctx } = await setup();
    localStorage.setItem("billie.report.queue", JSON.stringify([{ kind: "purge", account: ctx.account, seq: 5 }]));
    await reportAll({ ...ctx, databases: [] });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE /${deviceId()}?sequence=5`]);
  });

  it("Metadata Last Updated is recorded per successful report and dropped with a deleted database", async () => {
    const { ctx, first } = await setup();
    expect(reportingStatus(ctx.account).lastUpdatedAt).toBeNull();
    await reportAll(ctx);
    const at = reportingStatus(ctx.account).lastUpdatedAt!;
    expect(new Date(at).getTime()).toBeGreaterThan(Date.now() - 5000);
    const id = await first.reportId();
    expect(metadataUpdatedAt(ctx.account, id)).toBeTruthy();
    expect(metadataUpdatedAt(ctx.account, null)).toBeNull();
    queueDelete(ctx.account, id);
    expect(metadataUpdatedAt(ctx.account, id)).toBeNull();
  });

  it("reporting never syncs or backs up", async () => {
    const { ctx, first } = await setup();
    await reportAll(ctx);
    expect(await first.lastSyncedAt()).toBeNull();
    expect(calls.every((c) => c.method === "PUT")).toBe(true);
    expect(calls.every((c) => /^\/[0-9a-f-]{36}\/databases\/[0-9a-f-]{36}$/.test(c.url))).toBe(true);
    expect(Object.keys(localStorage).filter((key) => /backup/i.test(key))).toEqual([]);
  });

  it("reporting code is independent of sync, transfer, upload and backup code (and the other way round)", () => {
    const src = (file: string) => readFileSync(join(__dirname, "../src/services", file), "utf8");
    for (const file of ["reporting.ts", "localReport.ts"]) {
      expect(src(file)).not.toMatch(/from "\.\/(transfer|webSync|cloudUpload|cloudManage|cloudData|importFile)"/);
      expect(src(file)).not.toMatch(/runTransfer|syncFromWeb|uploadStatement|markSynced|exportData|mergeData/);
    }
    for (const file of ["transfer.ts", "cloudUpload.ts", "webSync.ts"]) {
      expect(src(file)).not.toMatch(/from "\.\/(reporting|localReport)"/);
    }
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
