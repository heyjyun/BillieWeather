// Data page: every database the person has: each local database on this device and the
// BillieWeather cloud. For each one: its name, size and share of the total, what it holds, and
// when it changed. From here they can name, create and delete databases (a delete needs a typed
// confirmation and cannot be undone), copy data from one database into another ("Sync"), and
// manage statements one at a time in the database in use and in the cloud.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { PageHeading } from "../components/common";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import { AccountError } from "../services/account";
import { deleteCloudStatement, fetchCloudStatements, fetchCloudSummary, type CloudStatement, type CloudSummary } from "../services/cloudData";
import { deleteCloudDatabase, renameCloudDatabase } from "../services/cloudManage";
import { DATABASE_NAME_MAX, normalizeDatabaseName, StoreError, type StatementInventoryItem } from "../services/store";
import { previewTransfer, runTransfer, sameEndpoint, type Endpoint } from "../services/transfer";

type Cloud = { status: "loading" } | { status: "ready"; summary: CloudSummary; statements: CloudStatement[] } | { status: "offline" | "failed" };
type Pending = { kind: "remove"; item: StatementInventoryItem } | { kind: "deleteCloud"; item: CloudStatement } | null;
type Target = "cloud" | string; // "cloud" or a local database id

interface LocalDb {
  id: string;
  name: string;
  sizeBytes: number;
  periodStart: string | null;
  periodEnd: string | null;
  items: StatementInventoryItem[];
  transactions: number;
  rules: number;
  lastChanged: string | null;
}

export function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
}

const endpointOf = (target: Target): Endpoint => (target === "cloud" ? { kind: "cloud" } : { kind: "local", id: target });

export function Data() {
  const { m, t, locale } = useI18n();
  const { getToken, expire } = useAccount();
  const finance = useFinance();
  const { store, refresh, transactions, syncEnabled, syncNow, persistent, databaseIds, activeDatabaseId, maxDatabases, openStore, switchDatabase, createDatabase, removeDatabase, renameDatabaseById, reportNow } = finance;
  const d = m.data;
  const [locals, setLocals] = useState<LocalDb[] | null>(null);
  const [cloud, setCloud] = useState<Cloud>({ status: "loading" });
  const [pending, setPending] = useState<Pending>(null);
  const [renaming, setRenaming] = useState<{ target: Target; value: string } | null>(null);
  const [deleting, setDeleting] = useState<{ target: Target; typed: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [from, setFrom] = useState<Target | "">("");
  const [to, setTo] = useState<Target | "">("");
  const [keepInCloud, setKeepInCloud] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const num = (value: number) => new Intl.NumberFormat(locale).format(value);
  const range = (start: string | null, end: string | null) => (start && end ? (start === end ? start : `${start} – ${end}`) : "—");
  const when = (iso: string | null) => {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date) : d.noChanges;
  };

  const loadLocals = useCallback(async () => {
    const loaded = await Promise.all(databaseIds.map(async (id): Promise<LocalDb | null> => {
      try {
        const db = await openStore(id);
        const [info, items, rules, name, lastChanged] = await Promise.all([db.databaseInfo(), db.statementInventory(), db.rules(), db.databaseName(), db.lastChanged()]);
        return { id, name: name ?? d.unnamed, ...info, items, transactions: items.reduce((sum, item) => sum + item.transactionCount, 0), rules: rules.length, lastChanged };
      } catch {
        return null; // a database that was just deleted, or one that can't be opened, is left out
      }
    }));
    setLocals(loaded.filter((db): db is LocalDb => db !== null));
  }, [databaseIds, openStore, d.unnamed]);
  const loadCloud = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setCloud((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      const [summary, statements] = await Promise.all([fetchCloudSummary(token), fetchCloudStatements(token)]);
      setCloud({ status: "ready", summary, statements });
    } catch (error) {
      if (error instanceof AccountError && error.code === "unauthorized") return expire();
      setCloud({ status: error instanceof AccountError && error.code === "offline" ? "offline" : "failed" });
    }
  }, [getToken, expire]);

  useEffect(() => { void loadLocals(); }, [loadLocals, transactions, activeDatabaseId]);
  useEffect(() => { void loadCloud(); }, [loadCloud]);

  const cloudName = cloud.status === "ready" ? cloud.summary.name ?? d.defaultCloudName : d.defaultCloudName;
  const nameOf = (target: Target) => (target === "cloud" ? cloudName : locals?.find((db) => db.id === target)?.name ?? d.unnamed);
  const active = locals?.find((db) => db.id === activeDatabaseId) ?? null;

  async function run(action: () => Promise<string>, reload: "all" | "none" = "all") {
    setBusy(true);
    setStatus(null);
    try {
      const text = await action();
      setStatus({ tone: "ok", text });
      setPending(null);
    } catch (error) {
      if (error instanceof AccountError && error.code === "unauthorized") return expire();
      const text = error instanceof StoreError && error.code === "currency_mismatch" ? d.currencyMismatch
        : error instanceof AccountError && error.message === "currency_mismatch" ? d.currencyMismatch : d.actionFailed;
      setStatus({ tone: "error", text });
    } finally {
      setBusy(false);
      if (reload === "all") {
        await refresh();
        await Promise.all([loadLocals(), loadCloud()]);
      }
    }
  }

  // ---- statements, one at a time (the database in use, and the cloud)
  const removeFromDevice = (item: StatementInventoryItem) => run(async () => {
    await store.removeStatement(item.id);
    return t("data.removed", { name: item.filename });
  });
  const deleteFromCloud = (item: CloudStatement) => run(async () => {
    const token = getToken();
    if (!token) throw new AccountError("unauthorized");
    await deleteCloudStatement(token, item.id);
    await syncNow(false); // the database in use follows right away
    return t("data.deletedCloud", { name: item.filename });
  });
  const downloadToDevice = (item: CloudStatement) => run(async () => {
    await store.allowDownload(item.sha256);
    await syncNow(true);
    return t("data.downloaded", { name: item.filename });
  });

  // ---- whole databases
  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (!renaming || !normalizeDatabaseName(renaming.value)) return;
    const { target, value } = renaming;
    await run(async () => {
      if (target === "cloud") {
        const token = getToken();
        if (!token) throw new AccountError("unauthorized");
        await renameCloudDatabase(token, normalizeDatabaseName(value));
      } else {
        await renameDatabaseById(target, value);
      }
      setRenaming(null);
      return d.renamed;
    });
  }

  const confirmDelete = () => deleting && run(async () => {
    const { target } = deleting;
    const name = nameOf(target);
    if (target === "cloud") {
      const token = getToken();
      if (!token) throw new AccountError("unauthorized");
      await deleteCloudDatabase(token);
      // Copies that came from the website stay on the devices as the devices' own data.
      for (const id of databaseIds) await (await openStore(id)).detachWebCopies();
    } else {
      await removeDatabase(target);
    }
    setDeleting(null);
    return t("data.deletedDb", { name });
  });

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (creating === null || !normalizeDatabaseName(creating)) return;
    const name = normalizeDatabaseName(creating);
    await run(async () => {
      await createDatabase(name);
      setCreating(null);
      return t("data.created", { name });
    });
  }

  // ---- sync between databases
  const hashesOf = useCallback((target: Target | ""): Set<string> | null => {
    if (target === "cloud") return cloud.status === "ready" ? new Set(cloud.statements.map((x) => x.sha256)) : null;
    const db = locals?.find((x) => x.id === target);
    return db ? new Set(db.items.map((x) => x.sha256)) : null;
  }, [cloud, locals]);
  const summaryOf = (target: Target | "") => {
    if (target === "cloud") return cloud.status === "ready" ? { statements: cloud.summary.statements, transactions: cloud.summary.transactions, changed: cloud.summary.lastUpdatedAt } : null;
    const db = locals?.find((x) => x.id === target);
    return db ? { statements: db.items.length, transactions: db.transactions, changed: db.lastChanged } : null;
  };
  const sourceItems = (target: Target | ""): Array<Pick<StatementInventoryItem, "sha256" | "transactionCount">> | null => {
    if (target === "cloud") return cloud.status === "ready" ? cloud.statements : null;
    return locals?.find((x) => x.id === target)?.items ?? null;
  };
  const preview = useMemo(() => {
    const items = from ? sourceItems(from) : null;
    const hashes = hashesOf(to);
    return items && hashes ? previewTransfer(items, hashes) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, hashesOf]);
  const choices: Target[] = ["cloud", ...databaseIds];
  const same = from !== "" && to !== "" && sameEndpoint(endpointOf(from), endpointOf(to));
  const localToLocal = from !== "" && to !== "" && from !== "cloud" && to !== "cloud";
  const canSync = from !== "" && to !== "" && !same && !busy && (preview === null || preview.statements > 0);

  const startSync = () => from !== "" && to !== "" && run(async () => {
    const outcome = await runTransfer(endpointOf(from), endpointOf(to), keepInCloud && localToLocal, { openStore, getToken });
    const base = outcome.statementsAdded === 0 && outcome.keptInCloud === 0
      ? t("data.syncedNothing", { target: nameOf(to) })
      : t("data.synced", { statements: num(outcome.statementsAdded), transactions: num(outcome.transactionsAdded), target: nameOf(to) });
    void reportNow(); // a sync the person started just finished
    return outcome.keptInCloud > 0 ? `${base} ${t("data.syncedKept", { count: num(outcome.keptInCloud) })}` : base;
  });

  // ---- storage shares
  const slices = useMemo(() => {
    const parts: Array<{ key: string; name: string; bytes: number }> = [];
    if (cloud.status === "ready") parts.push({ key: "cloud", name: cloudName, bytes: cloud.summary.storageBytes });
    for (const db of locals ?? []) parts.push({ key: db.id, name: db.name, bytes: db.sizeBytes });
    const total = parts.reduce((sum, part) => sum + part.bytes, 0);
    return { parts, total };
  }, [cloud, cloudName, locals]);
  const percent = (bytes: number) => {
    if (slices.total === 0) return "0%";
    const value = (bytes / slices.total) * 100;
    return bytes > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
  };

  const deviceHashes = new Set(active?.items.map((item) => item.sha256) ?? []);

  // Plain functions, not components: they must not remount (and drop input focus) on every keystroke.
  function nameForm(target: Target) {
    return renaming?.target === target ? (
      <form className="bw-db-rename" onSubmit={saveName}>
        <input aria-label={d.name} value={renaming.value} maxLength={DATABASE_NAME_MAX} autoFocus disabled={busy} onChange={(e) => setRenaming({ target, value: e.target.value })} />
        <button type="submit" className="bw-button bw-button-dark bw-button-small" disabled={busy || !normalizeDatabaseName(renaming.value)}>{d.saveName}</button>
        <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={() => setRenaming(null)}>{d.cancel}</button>
      </form>
    ) : null;
  }

  function deletePanel(target: Target, statements: number, transactionCount: number) {
    if (deleting?.target !== target) return null;
    const name = nameOf(target);
    const ready = deleting.typed.trim().toLowerCase() === d.deletePhrase.toLowerCase();
    const only = target !== "cloud" && databaseIds.length === 1;
    return (
      <div className="bw-confirm" role="group" aria-label={d.deleteDb}>
        <p>{t(target === "cloud" ? "data.deleteWarnCloud" : "data.deleteWarnLocal", { name, statements: num(statements), transactions: num(transactionCount) })}</p>
        {only && <p>{d.lastDbNote}</p>}
        <label className="bw-field">
          <span>{t("data.typeToConfirm", { phrase: d.deletePhrase })}</span>
          <input value={deleting.typed} autoComplete="off" disabled={busy} onChange={(e) => setDeleting({ target, typed: e.target.value })} />
        </label>
        <div>
          <button type="button" className="bw-button bw-button-danger bw-button-small" disabled={busy || !ready} onClick={confirmDelete}>{busy ? d.working : d.confirmDeleteDb}</button>
          <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={() => setDeleting(null)}>{d.cancel}</button>
        </div>
      </div>
    );
  }

  const shareFact = (bytes: number) => <div><dt>{d.share}</dt><dd>{percent(bytes)}</dd></div>;

  return (
    <>
      <PageHeading eyebrow={d.eyebrow} title={d.title} />
      <p className="bw-muted bw-data-intro">{d.intro}</p>
      {status && <p className={`bw-message bw-message-${status.tone}`} role={status.tone === "error" ? "alert" : "status"}>{status.text}</p>}

      <section className="bw-panel" aria-labelledby="usage-heading">
        <h2 id="usage-heading">{d.usage}</h2>
        <p className="bw-caption">{d.usageIntro}</p>
        {slices.total > 0 && (
          <div className="bw-usage-bar" role="img" aria-label={slices.parts.map((part) => `${part.name} ${percent(part.bytes)}`).join(", ")}>
            {slices.parts.map((part, index) => <span key={part.key} className={`bw-usage-${index % 6}`} style={{ width: `${(part.bytes / slices.total) * 100}%` }} />)}
          </div>
        )}
        <ul className="bw-usage-legend">
          {slices.parts.map((part, index) => (
            <li key={part.key} data-usage={part.key}><i className={`bw-usage-${index % 6}`} aria-hidden="true" /><span>{part.name}</span><strong>{percent(part.bytes)}</strong><small>{formatBytes(part.bytes, locale)}</small></li>
          ))}
        </ul>
        <p className="bw-caption">{t("data.total", { size: formatBytes(slices.total, locale) })}</p>
      </section>

      <div className="bw-db-grid">
        <section className="bw-panel bw-db-card" data-database="cloud" aria-labelledby="db-cloud">
          <h2 id="db-cloud">{cloudName}</h2>
          <span className="bw-tag bw-tag-muted">{d.kindCloud}</span>
          {cloud.status === "loading" && <p className="bw-muted">{d.loading}</p>}
          {(cloud.status === "offline" || cloud.status === "failed") && (
            <p className="bw-muted">{cloud.status === "offline" ? d.offline : d.failed} <button type="button" className="bw-link-button" onClick={() => loadCloud()}>{d.retry}</button></p>
          )}
          {cloud.status === "ready" && (
            <>
              {nameForm("cloud")}
              <dl className="bw-db-facts">
                <div><dt>{d.size}</dt><dd>{t("data.sizeApprox", { size: formatBytes(cloud.summary.storageBytes, locale) })}</dd></div>
                {shareFact(cloud.summary.storageBytes)}
                <div><dt>{d.statements}</dt><dd>{num(cloud.summary.statements)}</dd></div>
                <div><dt>{d.transactions}</dt><dd>{num(cloud.summary.transactions)}</dd></div>
                <div><dt>{d.rules}</dt><dd>{num(cloud.summary.rules)}</dd></div>
                <div><dt>{d.bankAccounts}</dt><dd>{num(cloud.summary.bankAccounts)}</dd></div>
                {cloud.summary.pendingImports > 0 && <div><dt>{d.pendingImports}</dt><dd>{num(cloud.summary.pendingImports)}</dd></div>}
                {cloud.summary.insights > 0 && <div><dt>{d.insights}</dt><dd>{num(cloud.summary.insights)}</dd></div>}
                <div><dt>{d.dates}</dt><dd>{range(cloud.summary.periodStart, cloud.summary.periodEnd)}</dd></div>
                <div><dt>{d.lastUpdated}</dt><dd>{when(cloud.summary.lastUpdatedAt)}</dd></div>
                <div className="bw-db-where"><dt>{d.where}</dt><dd>{d.whereCloud}</dd></div>
              </dl>
              <div className="bw-db-actions">
                <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={() => setRenaming({ target: "cloud", value: cloud.summary.name ?? "" })}>{d.rename}</button>
                <button type="button" className="bw-button bw-button-danger-outline bw-button-small" disabled={busy} onClick={() => setDeleting({ target: "cloud", typed: "" })}>{d.deleteDb}</button>
              </div>
              {deletePanel("cloud", cloud.summary.statements, cloud.summary.transactions)}
            </>
          )}
        </section>

        {(locals ?? []).map((db) => (
          <section key={db.id} className="bw-panel bw-db-card" data-database="device" data-active={db.id === activeDatabaseId} aria-labelledby={`db-${db.id}`}>
            <h2 id={`db-${db.id}`}>{db.name}</h2>
            <span>
              <span className="bw-tag bw-tag-muted">{d.kindDevice}</span>{" "}
              {db.id === activeDatabaseId && <span className="bw-tag">{d.inUse}</span>}
            </span>
            {nameForm(db.id)}
            <dl className="bw-db-facts">
              <div><dt>{d.size}</dt><dd>{formatBytes(db.sizeBytes, locale)}</dd></div>
              {shareFact(db.sizeBytes)}
              <div><dt>{d.statements}</dt><dd>{num(db.items.length)}</dd></div>
              <div><dt>{d.transactions}</dt><dd>{num(db.transactions)}</dd></div>
              <div><dt>{d.rules}</dt><dd>{num(db.rules)}</dd></div>
              <div><dt>{d.dates}</dt><dd>{range(db.periodStart, db.periodEnd)}</dd></div>
              <div><dt>{d.lastUpdated}</dt><dd>{when(db.lastChanged)}</dd></div>
              <div className="bw-db-where"><dt>{d.where}</dt><dd>{d.whereDevice}</dd></div>
            </dl>
            <div className="bw-db-actions">
              {db.id !== activeDatabaseId && <button type="button" className="bw-button bw-button-dark bw-button-small" disabled={busy} onClick={() => switchDatabase(db.id)}>{d.use}</button>}
              <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={() => setRenaming({ target: db.id, value: db.name === d.unnamed ? "" : db.name })}>{d.rename}</button>
              <button type="button" className="bw-button bw-button-danger-outline bw-button-small" disabled={busy} onClick={() => setDeleting({ target: db.id, typed: "" })}>{d.deleteDb}</button>
            </div>
            {deletePanel(db.id, db.items.length, db.transactions)}
          </section>
        ))}
      </div>
      <p className="bw-caption">{d.multiDevice}</p>

      <section className="bw-panel" aria-labelledby="new-db-heading">
        <h2 id="new-db-heading">{d.newDb}</h2>
        {!persistent ? <p className="bw-muted">{d.previewNoCreate}</p> : databaseIds.length >= maxDatabases ? <p className="bw-muted">{t("data.limitReached", { max: maxDatabases })}</p> : creating === null ? (
          <button type="button" className="bw-button bw-button-outline" disabled={busy} onClick={() => setCreating(t("data.newDbDefault", { n: databaseIds.length + 1 }))}>{d.newDb}</button>
        ) : (
          <form className="bw-db-rename" onSubmit={submitCreate}>
            <input aria-label={d.newDbName} value={creating} maxLength={DATABASE_NAME_MAX} autoFocus disabled={busy} onChange={(e) => setCreating(e.target.value)} />
            <button type="submit" className="bw-button bw-button-dark bw-button-small" disabled={busy || !normalizeDatabaseName(creating)}>{d.create}</button>
            <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={() => setCreating(null)}>{d.cancel}</button>
          </form>
        )}
      </section>

      <section className="bw-panel" aria-labelledby="sync-heading">
        <h2 id="sync-heading">{d.transferTitle}</h2>
        <p className="bw-caption">{d.transferIntro}</p>
        <div className="bw-sync-grid">
          {([["from", d.from, from, setFrom], ["to", d.to, to, setTo]] as const).map(([key, label, value, set]) => {
            const info = summaryOf(value);
            return (
              <div key={key} className="bw-sync-side">
                <label className="bw-field"><span>{label}</span>
                  <select aria-label={label} value={value} disabled={busy} onChange={(e) => set(e.target.value)}>
                    <option value="">{d.choose}</option>
                    {choices.map((choice) => <option key={choice} value={choice}>{nameOf(choice)}</option>)}
                  </select>
                </label>
                {info && <small data-sync-status={key}>{t("data.status", { statements: num(info.statements), transactions: num(info.transactions), when: when(info.changed) })}</small>}
              </div>
            );
          })}
        </div>
        {same && <p className="bw-caption">{d.sameDb}</p>}
        {from !== "" && to !== "" && !same && preview && (
          <p className="bw-sync-preview" role="status">
            {preview.statements > 0
              ? t("data.preview", { statements: num(preview.statements), transactions: num(preview.transactions), target: nameOf(to), already: num(preview.alreadyThere) })
              : t("data.previewNothing", { target: nameOf(to), source: nameOf(from) })}
          </p>
        )}
        {localToLocal && !same && (
          <label className="bw-checkbox-label">
            <input type="checkbox" checked={keepInCloud} disabled={busy} onChange={(e) => setKeepInCloud(e.target.checked)} />
            <span>{d.keepInCloud}</span>
          </label>
        )}
        {localToLocal && !same && <p className="bw-caption">{keepInCloud ? d.keepInCloudOn : d.keepInCloudOff}</p>}
        {to === "cloud" && !same && <p className="bw-caption">{d.toCloudNote}</p>}
        <button type="button" className="bw-button bw-button-dark" disabled={!canSync} onClick={startSync}>{busy ? d.working : d.sync}</button>
      </section>

      <section className="bw-panel" aria-labelledby="list-device">
        <h2 id="list-device">{t("data.statementsIn", { name: active?.name ?? "" })}</h2>
        {active && active.items.length === 0 && <p className="bw-muted">{d.noStatements}</p>}
        <ul className="bw-db-list">
          {active?.items.map((item) => (
            <li key={item.id} data-statement={item.filename}>
              <div className="bw-db-row">
                <div className="bw-db-name">
                  <strong>{item.filename}</strong>
                  <small>
                    <span className="bw-tag">{item.source === "web" ? d.fromWeb : d.importedHere}</span>
                    {range(item.periodStart, item.periodEnd)} · {t("data.count", { count: num(item.transactionCount) })}
                  </small>
                </div>
                {!(pending?.kind === "remove" && pending.item.id === item.id) && (
                  <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={() => setPending({ kind: "remove", item })}>{d.remove}</button>
                )}
              </div>
              {pending?.kind === "remove" && pending.item.id === item.id && (
                <div className="bw-confirm" role="group" aria-label={d.remove}>
                  <p>{t(item.source === "web" ? "data.removeConfirmWeb" : "data.removeConfirmLocal", { name: item.filename, count: num(item.transactionCount) })}</p>
                  <div>
                    <button type="button" className="bw-button bw-button-danger bw-button-small" disabled={busy} onClick={() => removeFromDevice(item)}>{busy ? d.working : d.confirmRemove}</button>
                    <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={() => setPending(null)}>{d.cancel}</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="bw-panel" aria-labelledby="list-cloud">
        <h2 id="list-cloud">{t("data.statementsIn", { name: cloudName })}</h2>
        {cloud.status === "ready" && cloud.statements.length === 0 && <p className="bw-muted">{d.noStatements}</p>}
        {cloud.status !== "ready" && <p className="bw-muted">{cloud.status === "loading" ? d.loading : cloud.status === "offline" ? d.offline : d.failed}</p>}
        {!syncEnabled && cloud.status === "ready" && cloud.statements.length > 0 && <p className="bw-caption">{d.downloadNeedsSync}</p>}
        <ul className="bw-db-list">
          {cloud.status === "ready" && cloud.statements.map((item) => {
            const here = deviceHashes.has(item.sha256);
            return (
              <li key={item.id} data-statement={item.filename}>
                <div className="bw-db-row">
                  <div className="bw-db-name">
                    <strong>{item.filename}</strong>
                    <small>
                      <span className={`bw-tag ${here ? "" : "bw-tag-muted"}`}>{here ? d.onThisDevice : d.notOnThisDevice}</span>
                      {range(item.periodStart, item.periodEnd)} · {t("data.count", { count: num(item.transactionCount) })}
                    </small>
                  </div>
                  {!(pending?.kind === "deleteCloud" && pending.item.id === item.id) && (
                    <div className="bw-db-actions">
                      {!here && <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy || !syncEnabled} onClick={() => downloadToDevice(item)}>{d.download}</button>}
                      <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={() => setPending({ kind: "deleteCloud", item })}>{d.deleteCloud}</button>
                    </div>
                  )}
                </div>
                {pending?.kind === "deleteCloud" && pending.item.id === item.id && (
                  <div className="bw-confirm" role="group" aria-label={d.deleteCloud}>
                    <p>{t("data.deleteCloudConfirm", { name: item.filename, count: num(item.transactionCount) })}</p>
                    <div>
                      <button type="button" className="bw-button bw-button-danger bw-button-small" disabled={busy} onClick={() => deleteFromCloud(item)}>{busy ? d.working : d.confirmDelete}</button>
                      <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={() => setPending(null)}>{d.cancel}</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
