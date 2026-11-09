// Decides WHEN to tell the website about this device's local databases, and keeps that promise
// to the person: nothing is reported unless they switched "Show My Local Databases on the
// Website" on (default OFF, per account); switching it off asks the server to forget everything
// this device reported, and that request is kept and retried until the server confirms.
//
// Only metadata (see localReport.ts) is ever sent. There is no background timer: reporting
// happens when the app opens and the person is signed in, and after they create, rename or
// delete a database or finish a sync. Offline, the app works as usual; only removals are queued.
import { AccountError } from "./account";
import { randomId } from "./ids";
import { deleteDatabaseReport, purgeDeviceReports, putDatabaseReport, type DatabaseReport } from "./localReport";
import type { FinanceStore } from "./store";

const K = {
  device: "billie.report.device",
  seq: "billie.report.seq",
  enabled: "billie.report.enabled",
  queue: "billie.report.queue",
  sent: "billie.report.sent",
  updatedAt: "billie.report.updatedAt",
  removed: "billie.report.removed",
};

type Op = { kind: "delete"; account: string; database: string; seq: number } | { kind: "purge"; account: string; seq: number };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: reporting simply stays off / is retried next time.
  }
}

const acct = (email: string) => email.trim().toLowerCase();

/** This installation's random id, created the first time it is needed and then kept. */
export function deviceId(): string {
  let id = read<string | null>(K.device, null);
  if (!id) {
    id = randomId();
    write(K.device, id);
  }
  return id;
}

/** Per-device counter that only goes up, so the server can tell a late retry from newer news. */
function nextSequence(): number {
  const next = Math.max(read<number>(K.seq, 0) + 1, Date.now());
  write(K.seq, next);
  return next;
}

const clean = (text: string, max: number) => [...text.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim()].slice(0, max).join("").trim();
const isoOrNull = (value: string | null) => (value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : null);

export interface ReportContext {
  /** The signed-in account's email (settings and the queue are kept per account). */
  account: string;
  token: string | null;
  deviceName: string;
  /** When this app session started. */
  openedAt: string;
  databases: Array<{ id: string; store: FinanceStore }>;
}

export interface ReportingStatus {
  enabled: boolean;
  /** Removal requests (deleted databases, or "stop sharing") the server hasn't confirmed yet. */
  pendingRemoval: boolean;
  /** The server confirmed it removed what this device reported. */
  removalConfirmed: boolean;
  /** "Metadata Last Updated": when the server last accepted a report from this device (this is NOT a sync or a backup). */
  lastUpdatedAt: string | null;
}

export function reportingStatus(account: string): ReportingStatus {
  const a = acct(account);
  const queue = read<Op[]>(K.queue, []);
  return {
    enabled: read<Record<string, boolean>>(K.enabled, {})[a] === true,
    pendingRemoval: queue.some((op) => op.account === a),
    removalConfirmed: read<Record<string, boolean>>(K.removed, {})[a] === true,
    lastUpdatedAt: Object.entries(read<Record<string, string>>(K.updatedAt, {})).filter(([key]) => key.startsWith(`${a}|`)).map(([, at]) => at).sort().at(-1) ?? null,
  };
}

/** When the server last accepted a report about one database (by its report id), or null. */
export function metadataUpdatedAt(account: string, databaseId: string | null): string | null {
  return databaseId ? read<Record<string, string>>(K.updatedAt, {})[sentKey(acct(account), databaseId)] ?? null : null;
}

const sentKey = (a: string, database: string) => `${a}|${database}`;

// One reporting job at a time, in order, so a retry can never overtake a newer request.
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const run = chain.then(job, job);
  chain = run.catch(() => undefined);
  return run;
};

/** Sends the queued removals for this account, oldest first. Returns true when none are left. */
async function flush(ctx: ReportContext): Promise<boolean> {
  const a = acct(ctx.account);
  if (!ctx.token) return !read<Op[]>(K.queue, []).some((op) => op.account === a);
  const device = deviceId();
  for (;;) {
    const queue = read<Op[]>(K.queue, []);
    const op = queue.find((candidate) => candidate.account === a);
    if (!op) return true;
    try {
      if (op.kind === "purge") await purgeDeviceReports(ctx.token, device, op.seq);
      else await deleteDatabaseReport(ctx.token, device, op.database, op.seq);
    } catch (error) {
      if (!(error instanceof AccountError && error.code === "invalid")) return false; // keep it and try again later
    }
    write(K.queue, read<Op[]>(K.queue, []).filter((candidate) => !(candidate.kind === op.kind && candidate.seq === op.seq && candidate.account === op.account)));
    if (op.kind === "purge") write(K.removed, { ...read<Record<string, boolean>>(K.removed, {}), [a]: true });
  }
}

async function collect(ctx: ReportContext, database: ContextDatabase): Promise<{ id: string; report: Omit<DatabaseReport, "sequence">; fingerprint: string }> {
  const summary = await database.store.reportSummary();
  const id = await database.store.reportId();
  const report = {
    name: clean(summary.name ?? "Unnamed database", 60) || "Unnamed database",
    device_name: clean(ctx.deviceName, 80) || "Unknown device",
    size_bytes: Math.max(0, Math.trunc(summary.sizeBytes)),
    statement_count: summary.statements,
    transaction_count: summary.transactions,
    rule_count: summary.rules,
    period_start: summary.periodStart,
    period_end: summary.periodEnd,
    modified_at: isoOrNull(summary.modifiedAt),
    opened_at: isoOrNull(ctx.openedAt),
  };
  return { id, report, fingerprint: JSON.stringify(report) };
}
type ContextDatabase = ReportContext["databases"][number];

/**
 * Reports every local database whose information changed since it was last sent (when the
 * person has switched reporting on), after sending any queued removals. Never throws:
 * a failure just means the website's card stays as it was until the next trigger.
 */
export function reportAll(ctx: ReportContext): Promise<void> {
  return serial(async () => {
    try {
      if (!(await flush(ctx))) return; // removals come first; if they can't be sent, nothing else is
      const a = acct(ctx.account);
      if (!reportingStatus(ctx.account).enabled || !ctx.token) return;
      const device = deviceId();
      for (const database of ctx.databases) {
        const { id, report, fingerprint } = await collect(ctx, database);
        const sent = read<Record<string, string>>(K.sent, {});
        if (sent[sentKey(a, id)] === fingerprint) continue; // nothing changed: no request
        await putDatabaseReport(ctx.token, device, id, { ...report, sequence: nextSequence() });
        write(K.sent, { ...read<Record<string, string>>(K.sent, {}), [sentKey(a, id)]: fingerprint });
        write(K.updatedAt, { ...read<Record<string, string>>(K.updatedAt, {}), [sentKey(a, id)]: new Date().toISOString() });
      }
    } catch {
      // Offline, signed out, or refused: the app carries on and retries at the next trigger.
    }
  });
}

/** A database was deleted on this device: ask the server to drop its card (queued until confirmed). */
export function queueDelete(account: string, databaseId: string | null): void {
  if (!databaseId) return;
  const a = acct(account);
  const sent = read<Record<string, string>>(K.sent, {});
  const wasReported = sentKey(a, databaseId) in sent;
  if (!wasReported && !reportingStatus(account).enabled) return; // nothing was ever shared about it
  const { [sentKey(a, databaseId)]: _gone, ...rest } = sent;
  write(K.sent, rest);
  const { [sentKey(a, databaseId)]: _at, ...updated } = read<Record<string, string>>(K.updatedAt, {});
  write(K.updatedAt, updated);
  write(K.queue, [...read<Op[]>(K.queue, []), { kind: "delete", account: a, database: databaseId, seq: nextSequence() }]);
}

/** Turns "Show My Local Databases on the Website" on or off for this account on this device. */
export function setReporting(ctx: ReportContext, enabled: boolean): Promise<void> {
  const a = acct(ctx.account);
  const flags = read<Record<string, boolean>>(K.enabled, {});
  write(K.enabled, { ...flags, [a]: enabled });
  if (enabled) {
    write(K.removed, { ...read<Record<string, boolean>>(K.removed, {}), [a]: false });
    return reportAll(ctx);
  }
  // Off: forget what we sent, and ask the server to forget it too. A single purge covers any
  // removals that were still queued, so those are dropped in its favour.
  const sent = read<Record<string, string>>(K.sent, {});
  write(K.sent, Object.fromEntries(Object.entries(sent).filter(([key]) => !key.startsWith(`${a}|`))));
  write(K.updatedAt, Object.fromEntries(Object.entries(read<Record<string, string>>(K.updatedAt, {})).filter(([key]) => !key.startsWith(`${a}|`))));
  write(K.queue, [...read<Op[]>(K.queue, []).filter((op) => op.account !== a), { kind: "purge", account: a, seq: nextSequence() }]);
  write(K.removed, { ...read<Record<string, boolean>>(K.removed, {}), [a]: false });
  return reportAll(ctx);
}
