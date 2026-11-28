// Settings › Feature Library: every BillieWeather module, whether it works in the app, a way to open
// it, and whether it shows in the sidebar. The switch only changes the sidebar: an available module
// opens and keeps working whether it is shown or hidden, and no financial record is touched.
// Choices are kept on this device for this account and synchronized with the account
// (services/modulePreferences.ts, services/moduleSync.ts).
import { availabilityOf, isAvailable, MODULES, type ModuleDefinition } from "@billie/shared-types";
import { useState } from "react";
import { ModuleIcon } from "../components/ModuleIcon";
import { websitePathFor } from "../components/ModuleUnavailable";
import { useModules } from "../hooks/useModules";
import { useI18n } from "../i18n";
import { websiteUrl } from "../services/account";
import { openExternal } from "../services/session";

type Filter = "all" | "sidebar" | "hidden" | "unavailable";
const FILTERS: Filter[] = ["all", "sidebar", "hidden", "unavailable"];

type OpenModule = (module: ModuleDefinition) => void;

export function FeatureLibrary({ open }: { open: OpenModule }) {
  return <FeatureManager open={open} />;
}

export function FeatureManager({ open, openLibrary, embedded = false }: {
  open?: OpenModule; openLibrary?: () => void; embedded?: boolean;
}) {
  const { m, t, locale } = useI18n();
  const { sidebarList, inSidebar, setSidebarVisible, restoreSidebarDefaults, status: syncStatus, conflicts, resolve, serverInSidebar } = useModules();
  const [filter, setFilter] = useState<Filter>("all");
  const [status, setStatus] = useState("");
  const x = m.modules;
  const shown = [...MODULES].sort((a, b) => Number(isAvailable(b, "app")) - Number(isAvailable(a, "app")) || a.order - b.order).filter((module) => {
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
    <section className="bw-panel bw-feature-manager" id={embedded ? "settings-feature-library" : "feature-manager"} aria-labelledby="feature-manager-title">
      {embedded ? <h2 id="feature-manager-title">{x.library.management}</h2> : <><p className="bw-eyebrow">{x.library.eyebrow}</p><h1 id="feature-manager-title">{x.library.title}</h1></>}
      <p className="bw-muted">{x.library.sidebarIntro}</p>
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
      {!embedded && <div className="bw-library-toolbar">
        <div className="bw-segmented" role="group" aria-label={x.library.filtersLabel}>
          {FILTERS.map((key) => (
            <button key={key} type="button" className={filter === key ? "is-active" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}>{x.library.filters[key]}</button>
          ))}
        </div>
      </div>}
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      {shown.length === 0 ? <p className="bw-muted">{x.library.empty}</p> : (
        <ul className="bw-feature-rows" role="list" id="feature-library">
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
                    {!available && <span className="bw-caption">{state === "unsupported" ? x.status.unsupported : x.status.comingSoon}</span>}
                  </div>
                  {available && open && <button type="button" className="bw-link-button bw-feature-open" aria-label={`${x.library.openModule} ${name}`} onClick={() => open(module)}>{x.library.openModule}</button>}
                  {web && <button type="button" className="bw-link-button bw-feature-open" onClick={() => openExternal(websiteUrl(web, locale))}>{x.library.openOnWeb} ↗</button>}
                  {available && (
                    <button type="button" className="bw-switch" role="switch" aria-checked={visible} disabled={!!conflicts[module.id]}
                      aria-label={t("modules.library.toggleLabel", { name })} aria-describedby={`module-${module.id}-desc`} title={t("modules.library.toggleLabel", { name })}
                      onClick={() => toggle(module)}>
                      <span className="bw-switch-track" aria-hidden="true"><span className="bw-switch-thumb" /></span>
                    </button>
                  )}
                </div>
                <p id={`module-${module.id}-desc`} className="bw-sr-only">
                  {x.descriptions[module.id]}
                  {!available && <span className="bw-library-note">{state === "unsupported" ? x.library.unsupportedNote : x.library.comingSoonNote}</span>}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <div className="bw-feature-locked">
        <span>{x.nav.settings}</span>
        <span><ModuleIcon name="lock" size={16} /> {x.library.alwaysShown}</span>
      </div>
      <section className="bw-sidebar-preview" data-sidebar-preview aria-labelledby="sidebar-preview-title">
        <h3 id="sidebar-preview-title">{x.library.preview}</h3>
        <ul>
          {sidebarList.map((module) => <li key={module.id}><ModuleIcon name={module.icon} /> {x.names[module.id]}</li>)}
          <li><ModuleIcon name="settings" /> {x.nav.settings}</li>
        </ul>
      </section>
      {/* In Settings, Restore defaults lives in Sidebar customization (one button per page). */}
      {!embedded && <button type="button" className="bw-button bw-button-outline bw-feature-reset" onClick={() => {
        restoreSidebarDefaults();
        setStatus(x.library.resetSaved);
      }}>{x.library.reset}</button>}
      {openLibrary && <button type="button" className="bw-link-button" onClick={openLibrary}>{x.library.open}</button>}
      <p className="bw-caption" role="status">{syncStatus === "local" ? x.library.syncNote : x.sync[syncStatus]}</p>
    </section>
  );
}
