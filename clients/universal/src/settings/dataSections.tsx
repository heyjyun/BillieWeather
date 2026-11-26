// Settings › Database, Data and Sync. Each lists what BillieWeather actually does today and links to
// the page that does it (the Data page is the database manager). Capabilities that do not exist yet are
// marked "Not available yet" and have no button.
import { useEffect, useState } from "react";
import { useAccount } from "../hooks/useAccount";
import { useFinance } from "../hooks/useFinance";
import { useModules } from "../hooks/useModules";
import { useI18n } from "../i18n";
import { checkDatabase } from "../services/databaseHealth";
import { formatBytes } from "../services/bytes";
import type { SectionProps } from "./registry";

type Capability = { key: "manage" | "storage" | "integrity" | "backup" | "transfer" | "scheduled" | "repair"; action?: () => void };

function CapabilityList({ items }: { items: Capability[] }) {
  const { m } = useI18n();
  const h = m.settingsHub;
  return (
    <ul className="bw-settings-capabilities" id="settings-database-tools">
      {items.map((item) => {
        const text = h.database.caps[item.key];
        const ready = item.key !== "scheduled" && item.key !== "repair";
        return (
          <li key={item.key} data-capability={item.key} data-status={ready ? "available" : "not_yet"}>
            <div>
              <strong>{text.title}</strong>
              <span className={`bw-badge ${ready ? "bw-badge-available" : "bw-badge-soon"}`}>{ready ? h.available : h.notYet}</span>
              <p className="bw-caption">{text.body}</p>
            </div>
            {ready && item.action && <button type="button" className="bw-button bw-button-outline bw-button-small" onClick={item.action}>{h.open}</button>}
          </li>
        );
      })}
    </ul>
  );
}

interface Facts { sizeBytes: number; periodStart: string | null; periodEnd: string | null }

export function DatabaseSection({ shell }: SectionProps) {
  const { m, t, locale } = useI18n();
  const finance = useFinance();
  const h = m.settingsHub.database;
  const [facts, setFacts] = useState<Facts | null>(null);
  const [health, setHealth] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const store = finance.store;
  const num = (value: number) => new Intl.NumberFormat(locale).format(value);

  useEffect(() => {
    let cancelled = false;
    // Rendered on its own (tests, previews) the store may not be a real database: show "—", never fail.
    Promise.resolve().then(() => store.databaseInfo()).then((info) => { if (!cancelled) setFacts(info); }, () => { if (!cancelled) setFacts(null); });
    return () => { cancelled = true; };
  }, [store, finance.transactions]);

  async function runCheck() {
    setChecking(true);
    setHealth(null);
    try {
      const result = await checkDatabase(store.sql);
      setHealth(result.ok ? { tone: "ok", text: h.checkOk } : { tone: "error", text: t("settingsHub.database.checkProblems", { count: result.problems }) });
    } catch {
      setHealth({ tone: "error", text: h.checkFailed });
    } finally {
      setChecking(false);
    }
  }

  const go = shell?.go;
  const range = facts?.periodStart && facts.periodEnd ? (facts.periodStart === facts.periodEnd ? facts.periodStart : `${facts.periodStart} – ${facts.periodEnd}`) : "—";
  return (
    <section className="bw-panel" aria-labelledby="settings-database-heading" id="settings-database">
      <h2 id="settings-database-heading">{m.settingsHub.areas.database}</h2>
      <p className="bw-caption">{h.intro}</p>
      <dl className="bw-db-facts">
        <div><dt>{h.name}</dt><dd>{finance.databaseName ?? m.data.unnamed}</dd></div>
        <div><dt>{h.location}</dt><dd>{finance.persistent ? h.locationDevice : h.locationPreview}</dd></div>
        <div><dt>{h.size}</dt><dd>{facts ? formatBytes(facts.sizeBytes, locale) : "—"}</dd></div>
        <div><dt>{h.statements}</dt><dd>{num(finance.statements?.length ?? 0)}</dd></div>
        <div><dt>{h.transactions}</dt><dd>{num(finance.transactions?.length ?? 0)}</dd></div>
        <div><dt>{h.rules}</dt><dd>{num(finance.rules?.length ?? 0)}</dd></div>
        <div><dt>{h.dates}</dt><dd>{range}</dd></div>
      </dl>
      <div className="bw-db-actions">
        {go && <button type="button" className="bw-button bw-button-dark" onClick={() => go("data")}>{h.manager}</button>}
        <button type="button" className="bw-button bw-button-outline" id="settings-integrity-check" disabled={checking} onClick={() => void runCheck()}>{checking ? h.checking : h.check}</button>
      </div>
      {health && <p className={`bw-message bw-message-${health.tone}`} aria-live="polite" data-integrity={health.tone}>{health.text}</p>}
      <h3 className="bw-section-gap">{h.capabilities}</h3>
      <CapabilityList items={[
        { key: "manage", action: go && (() => go("data")) },
        { key: "storage", action: go && (() => go("data")) },
        { key: "integrity", action: () => void runCheck() },
        { key: "backup", action: go && (() => go("data", "backup")) },
        { key: "transfer", action: go && (() => go("data", "sync")) },
        { key: "scheduled" },
        { key: "repair" },
      ]} />
    </section>
  );
}

export function DataSection({ shell }: SectionProps) {
  const { m, t } = useI18n();
  const { statements } = useFinance();
  const { usable } = useModules();
  const h = m.settingsHub.data;
  if (!shell) return null;
  const { go } = shell;
  const rows: Array<{ key: string; title: string; body: string; action: string; open: () => void }> = [
    { key: "import", ...h.import, open: () => go("import") },
    ...(usable("reports") ? [{ key: "export", ...h.export, open: () => go("reports") }] : []),
    { key: "statements", ...h.statements, body: t("settingsHub.data.statements.body", { count: statements?.length ?? 0 }), open: () => go("data", "statements") },
    { key: "organize", ...h.organize, open: () => go("transactions", null, undefined, { view: "organize" }) },
  ];
  return (
    <section className="bw-panel" aria-labelledby="settings-data-heading" id="settings-data">
      <h2 id="settings-data-heading">{m.settingsHub.areas.data}</h2>
      <p className="bw-caption">{h.intro}</p>
      <ul className="bw-settings-capabilities">
        {rows.map((row) => (
          <li key={row.key} data-data-tool={row.key}>
            <div><strong>{row.title}</strong><p className="bw-caption">{row.body}</p></div>
            <button type="button" className="bw-button bw-button-outline bw-button-small" onClick={row.open}>{row.action}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Status only. Website data downloads on its own (Settings deliberately has no website-download
// switch: "Download to this device" on the Data page turns it back on if it was ever off).
export function SyncSection({ shell }: SectionProps) {
  const { m, locale } = useI18n();
  const { offline } = useAccount();
  const finance = useFinance();
  const modules = useModules();
  const h = m.settingsHub.sync;
  const persistent = finance.persistent === true;
  const enabled = finance.syncEnabled === true;
  const checked = finance.lastChecked ? new Date(finance.lastChecked) : null;
  const when = checked && !Number.isNaN(checked.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(checked) : h.never;
  const sidebarText = modules.status === "local" ? m.modules.library.syncNote : m.modules.sync[modules.status];
  return (
    <section className="bw-panel" aria-labelledby="settings-sync-heading" id="settings-sync">
      <h2 id="settings-sync-heading">{m.settingsHub.areas.sync}</h2>
      <p className="bw-caption">{h.intro}</p>
      <dl className="bw-db-facts">
        <div><dt>{h.connection}</dt><dd>{offline ? h.offline : h.online}</dd></div>
        <div data-sync-setting="website"><dt>{h.website}</dt><dd>{persistent ? (enabled ? h.websiteOn : h.websiteOff) : h.previewOnly}</dd></div>
        {persistent && enabled && <div><dt>{h.lastChecked}</dt><dd>{when}</dd></div>}
        <div data-sync-setting="sidebar"><dt>{h.sidebar}</dt><dd>{sidebarText}</dd></div>
      </dl>
      {shell && <div className="bw-db-actions"><button type="button" className="bw-button bw-button-outline" onClick={() => shell.go("data", "sync")}>{h.transferAction}</button></div>}
    </section>
  );
}
