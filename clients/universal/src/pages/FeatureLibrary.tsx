// Settings › Feature Library: every BillieWeather module, whether it works in the app, a way to open
// it, and whether it shows in the sidebar. The switch only changes the sidebar: an available module
// opens and keeps working whether it is shown or hidden, and no financial record is touched.
// Choices are kept on this device for this account and synchronized with the account
// (services/modulePreferences.ts, services/moduleSync.ts).
import { availabilityOf, isAvailable, MODULES, type ModuleDefinition } from "@billie/shared-types";
import { useState } from "react";
import { PageHeading } from "../components/common";
import { ModuleIcon } from "../components/ModuleIcon";
import { websitePathFor } from "../components/ModuleUnavailable";
import { useModules } from "../hooks/useModules";
import { useI18n } from "../i18n";
import { websiteUrl } from "../services/account";
import { openExternal } from "../services/session";

type Filter = "all" | "sidebar" | "hidden" | "unavailable";
const FILTERS: Filter[] = ["all", "sidebar", "hidden", "unavailable"];

export function FeatureLibrary({ open }: { open: (module: ModuleDefinition) => void }) {
  const { m, t, locale } = useI18n();
  const { inSidebar, setSidebarVisible, restoreSidebarDefaults, status: syncStatus, conflicts, resolve, serverInSidebar } = useModules();
  const [filter, setFilter] = useState<Filter>("all");
  const [status, setStatus] = useState("");
  const x = m.modules;
  const shown = MODULES.filter((module) => {
    const available = isAvailable(module, "app");
    if (filter === "sidebar") return inSidebar(module.id);
    if (filter === "hidden") return available && !inSidebar(module.id);
    if (filter === "unavailable") return !available;
    return true;
  });
  const sidebarText = (visible: boolean) => (visible ? x.status.inSidebar : x.status.hidden);

  function toggle(module: ModuleDefinition) {
    const visible = !inSidebar(module.id);
    setSidebarVisible(module.id, visible);
    setStatus(t(visible ? "modules.library.savedShown" : "modules.library.savedHidden", { name: x.names[module.id] }));
  }

  return (
    <>
      <PageHeading eyebrow={x.library.eyebrow} title={x.library.title} />
      <p className="bw-muted">{x.library.intro}</p>
      {Object.entries(conflicts).map(([id, conflict]) => {
        const definition = MODULES.find((module) => module.id === id);
        if (!definition || !isAvailable(definition, "app")) return null;
        const label = x.names[definition.id];
        return (
          <section key={id} className="bw-panel bw-module-conflict" aria-label={label}>
            <h2>{label}</h2>
            <p>{conflict.kind === "local_only" ? x.sync.localOnly : x.sync.different}</p>
            <dl>
              <div><dt>{x.sync.device}</dt><dd>{sidebarText(conflict.visible)}</dd></div>
              <div><dt>{x.sync.account}</dt><dd>{sidebarText(serverInSidebar(id))}</dd></div>
            </dl>
            <div className="bw-db-actions">
              <button type="button" className="bw-button bw-button-dark" onClick={() => resolve(id, true)}>{x.sync.keepLocal}</button>
              <button type="button" className="bw-button bw-button-outline" onClick={() => resolve(id, false)}>{x.sync.useAccount}</button>
            </div>
          </section>
        );
      })}
      <div className="bw-library-toolbar">
        <div className="bw-segmented" role="group" aria-label={x.library.filtersLabel}>
          {FILTERS.map((key) => (
            <button key={key} type="button" className={filter === key ? "is-active" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}>{x.library.filters[key]}</button>
          ))}
        </div>
        <button type="button" className="bw-button bw-button-outline bw-button-small" onClick={() => {
          restoreSidebarDefaults();
          setStatus(x.library.resetSaved);
        }}>{x.library.reset}</button>
        <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      </div>
      {shown.length === 0 ? <p className="bw-muted">{x.library.empty}</p> : (
        <ul className="bw-library-grid" role="list" id="feature-library">
          {shown.map((module) => {
            const state = availabilityOf(module, "app");
            const available = state === "available";
            const visible = inSidebar(module.id);
            const name = x.names[module.id];
            const web = websitePathFor(module);
            return (
              <li key={module.id} className={`bw-library-card${visible ? " is-on" : ""}${available ? "" : " is-coming-soon"}`} data-module={module.id} data-availability={state} data-sidebar={visible}>
                <div className="bw-library-card-head">
                  <span className="bw-library-icon"><ModuleIcon name={module.icon} size={22} /></span>
                  <div className="bw-library-title">
                    <h2 id={`module-${module.id}-name`}>{name}</h2>
                    <span className="bw-library-badges">
                      {module.core && <span className="bw-badge bw-badge-quiet">{x.status.core}</span>}
                      <span className={`bw-badge ${available ? "bw-badge-available" : "bw-badge-soon"}`}>{available ? x.status.available : state === "unsupported" ? x.status.unsupported : x.status.comingSoon}</span>
                    </span>
                  </div>
                  {available && (
                    <button type="button" className="bw-switch" role="switch" aria-checked={visible} disabled={!!conflicts[module.id]}
                      aria-label={t("modules.library.toggleLabel", { name })} aria-describedby={`module-${module.id}-desc`} title={t("modules.library.toggleLabel", { name })}
                      onClick={() => toggle(module)}>
                      <span className="bw-switch-track" aria-hidden="true"><span className="bw-switch-thumb" /></span>
                      <span className="bw-switch-text" aria-hidden="true">{sidebarText(visible)}</span>
                    </button>
                  )}
                </div>
                <p id={`module-${module.id}-desc`} className="bw-library-desc">
                  {x.descriptions[module.id]}
                  {!available && <span className="bw-library-note">{state === "unsupported" ? x.library.unsupportedNote : x.library.comingSoonNote}</span>}
                </p>
                {available && (
                  <p className="bw-library-open">
                    <button type="button" className="bw-link-button" aria-label={`${x.library.openModule} ${name}`} onClick={() => open(module)}>{x.library.openModule}</button>
                    {!visible && <span className="bw-caption"> · {x.library.hiddenStillWorks}</span>}
                  </p>
                )}
                {web && <p className="bw-library-open"><button type="button" className="bw-link-button" onClick={() => openExternal(websiteUrl(web, locale))}>{x.library.openOnWeb} ↗</button></p>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="bw-library-notes">
        <p className="bw-caption">{x.library.settingsNote}</p>
        <p className="bw-caption">{x.library.dataNote}</p>
        <p className="bw-caption" role="status">{syncStatus === "local" ? x.library.syncNote : x.sync[syncStatus]}</p>
      </div>
    </>
  );
}
