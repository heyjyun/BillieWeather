// Backup & restore on the Data page (review P0-5). A backup is one file the person keeps; a restore
// always becomes a NEW database and is verified against the backup before it is listed.
import { useEffect, useState } from "react";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import { BackupError, backupFileName, createBackup, isEncryptedBackup, readBackup, restoreInto, serializeBackup } from "../services/backup";
import { listSnapshots, openFile, saveFile } from "../services/platform";

export function BackupPanel() {
  const { m, t } = useI18n();
  const x = m.ledger.backup;
  const { store, databaseName, ownerKey, claimSlotForRestore, adoptRestored, openSnapshot } = useFinance();
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<{ bytes: Uint8Array } | null>(null);
  const [restorePass, setRestorePass] = useState("");
  const [busy, setBusy] = useState(false);
  const [snapshots, setSnapshots] = useState<Awaited<ReturnType<typeof listSnapshots>>>([]);
  useEffect(() => { Promise.resolve().then(() => listSnapshots()).then(setSnapshots).catch(() => setSnapshots([])); }, []);

  const fail = (error: unknown) => setStatus({ ok: false, text: error instanceof BackupError ? x.errors[error.code] : m.ledger.errors.unknown });

  async function backUp() {
    setBusy(true);
    try {
      const content = await createBackup(store.sql);
      const rows = Object.values(content.manifest.rows).reduce((sum, n) => sum + n, 0);
      if (await saveFile(backupFileName(databaseName), await serializeBackup(content, passphrase || null), "application/json")) {
        await store.ledger.audit({ action: "backup", subjectType: "book", subjectId: content.book.uuid, summary: `${rows} rows` });
        setStatus({ ok: true, text: t("ledger.backup.created", { rows }) });
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function restore(bytes: Uint8Array, pass: string | null) {
    setBusy(true);
    setStatus({ ok: true, text: x.restoring });
    try {
      const content = await readBackup(bytes, pass);
      const slot = await claimSlotForRestore();
      if (!slot) throw new BackupError("verify_failed", "no slot");
      const name = t("ledger.backup.restoredName", { name: content.book.name ?? "BillieWeather" }).slice(0, 60);
      await restoreInto(slot.store.sql, content, { owner: ownerKey, name });
      await adoptRestored(slot.id);
      setPending(null);
      setRestorePass("");
      setStatus({ ok: true, text: t("ledger.backup.restored", { name }) });
    } catch (error) {
      if (error instanceof BackupError && error.message === "no slot") setStatus({ ok: false, text: x.errors.no_room });
      else fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function choose() {
    const file = await openFile(["bwbackup", "json"]);
    if (!file) return;
    if (isEncryptedBackup(file.bytes)) setPending({ bytes: file.bytes });
    else await restore(file.bytes, null);
  }

  return (
    <section className="bw-panel" aria-labelledby="backup-heading">
      <h2 id="backup-heading">{x.title}</h2>
      <p className="bw-caption">{x.intro}</p>
      <label className="bw-field"><span>{x.passphrase}</span><input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} /><small>{x.passphraseHelp}</small></label>
      <div className="bw-actions">
        <button type="button" className="bw-button bw-button-dark" disabled={busy} onClick={backUp}>{x.create}</button>
        <button type="button" className="bw-button bw-button-outline" disabled={busy} onClick={choose}>{x.choose}</button>
      </div>
      <p className="bw-caption">{x.restore}: {x.restoreHelp}</p>
      {pending && (
        <form className="bw-cat-form" onSubmit={(e) => { e.preventDefault(); void restore(pending.bytes, restorePass); }}>
          <label className="bw-field bw-grow"><span>{x.restorePassphrase}</span><input type="password" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} autoFocus /></label>
          <button type="submit" className="bw-button" disabled={busy}>{x.restore}</button>
        </form>
      )}
      {status && <p className={`bw-message ${status.ok ? "bw-message-ok" : "bw-message-error"}`} role={status.ok ? "status" : "alert"}>{status.text}</p>}
      <h3>{x.snapshots}</h3>
      <p className="bw-caption">{x.snapshotsIntro}</p>
      {snapshots.length === 0 ? <p className="bw-muted">{x.noSnapshots}</p> : (
        <ul className="bw-simple-list">
          {snapshots.map((snapshot) => (
            <li key={snapshot.name}>
              <span>{snapshot.database} · v{snapshot.version} · {new Date(snapshot.created * 1000).toLocaleString()} · {Math.ceil(snapshot.size / 1024)} KB</span>{" "}
              <button type="button" className="bw-link-button" disabled={busy} onClick={async () => setStatus((await openSnapshot(snapshot.name)) ? { ok: true, text: x.snapshotRestored } : { ok: false, text: x.errors.no_room })}>{x.restoreSnapshot}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
