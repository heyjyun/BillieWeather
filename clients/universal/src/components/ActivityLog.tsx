// The operation log (操作日志): every change to this book, newest first. Stored only on this device.
import { useEffect, useState } from "react";
import { useFinance } from "../hooks/useFinance";
import { useI18n } from "../i18n";
import type { AuditEvent } from "../services/ledger";

export function ActivityLog() {
  const { m, t } = useI18n();
  const x = m.ledger.activity;
  const { store, transactions, accounts, refresh } = useFinance();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [actor, setActor] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => { void store.ledger.auditEvents({ limit: 200, actor: actor || undefined }).then(setEvents); }, [store, transactions, accounts, actor]);
  const label = (map: Record<string, string>, key: string) => map[key] ?? key;
  return (
    <section className="bw-panel" aria-labelledby="activity-heading">
      <h2 id="activity-heading">{x.title}</h2>
      <p className="bw-caption">{x.intro}</p>
      <label className="bw-field"><span>{m.ledger.list.any}</span>
        <select value={actor} onChange={(e) => setActor(e.target.value)}>
          <option value="">—</option>
          {Object.entries(x.actors).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select>
      </label>
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      {events.length === 0 ? <p className="bw-muted">{x.empty}</p> : (
        <ul className="bw-simple-list bw-activity">
          {events.map((event) => (
            <li key={event.id}>
              <small>{new Date(event.at).toLocaleString()}</small>{" "}
              <strong>{label(x.actors, event.actor)}</strong> · {label(x.actions, event.action)} {label(x.subjects, event.subjectType)}
              {event.summary ? `: ${event.summary}` : ""}
              {event.changes && Object.keys(event.changes).length > 0 && <small className="bw-muted"> ({Object.keys(event.changes).join(", ")})</small>}
              {event.action === "ai_apply" && event.subjectId && (
                <button type="button" className="bw-link-button" onClick={async () => { const count = await store.ledger.undoBatch(event.subjectId!); await refresh(); setStatus(t("ledger.activity.undone", { count })); }}>{x.undo}</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
