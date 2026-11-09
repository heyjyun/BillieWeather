// First run on a device: before anything is stored, the person names this device's local
// database. The field starts with the device's own name (computer name, phone model), so
// one tap on "Create" is enough; any other name works too.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "../i18n";
import { deviceName } from "../services/platform";
import { DATABASE_NAME_MAX, normalizeDatabaseName } from "../services/store";

export function NameDatabase({ onSave }: { onSave: (name: string) => Promise<void> }) {
  const { m } = useI18n();
  const n = m.dbName;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const edited = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void deviceName().then((detected) => {
      if (!cancelled && !edited.current) setName(detected ?? n.fallback);
    });
    return () => { cancelled = true; };
  }, [n.fallback]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = normalizeDatabaseName(name);
    if (!clean) return;
    setBusy(true);
    setError(false);
    try {
      await onSave(clean);
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return (
    <main className="bw-login">
      <div className="bw-login-card">
        <div className="bw-login-top">
          <div className="bw-brand"><span className="bw-brand-mark">b<small>·</small></span><span>BillieWeather</span></div>
        </div>
        <span className="bw-eyebrow">{n.eyebrow}</span>
        <h1>{n.heading}</h1>
        <p className="bw-muted">{n.intro}</p>
        <form onSubmit={submit} className="bw-login-form" noValidate>
          <label className="bw-field"><span>{n.label}</span>
            <input
              aria-label={n.label}
              aria-describedby="db-name-help"
              value={name}
              maxLength={DATABASE_NAME_MAX}
              autoComplete="off"
              autoFocus
              disabled={busy}
              onChange={(e) => { edited.current = true; setName(e.target.value); }}
            />
            <small id="db-name-help">{n.help}</small>
          </label>
          {error && <p className="bw-message bw-message-error" role="alert">{n.failed}</p>}
          <button type="submit" className="bw-button bw-button-dark" disabled={busy || !normalizeDatabaseName(name)}>{busy ? n.creating : n.create}</button>
        </form>
      </div>
      <p className="bw-login-footer">{m.footer}</p>
    </main>
  );
}
