// Settings › Feature Library: turn modules on or off. Only the sidebar and which pages open change;
// no financial record is touched. Choices are kept on this device for this account
// (services/modulePreferences.ts); the website keeps its own until Phase 1b.
import { isAvailable, MODULES, type ModuleDefinition } from "@billie/shared-types";
import { useState } from "react";
import { PageHeading } from "../components/common";
import { ModuleIcon } from "../components/ModuleIcon";
import { useModules } from "../hooks/useModules";
import { useI18n } from "../i18n";

type Filter = "all" | "enabled" | "available" | "comingSoon";
const FILTERS: Filter[] = ["all", "enabled", "available", "comingSoon"];

export function FeatureLibrary({ open }: { open: (module: ModuleDefinition) => void }) {
  const { m, t } = useI18n();
  const { enabled, setEnabled } = useModules();
  const [filter, setFilter] = useState<Filter>("all");
  const [status, setStatus] = useState("");
  const x = m.modules;
  const shown = MODULES.filter((module) => {
    const available = isAvailable(module, "app");
    if (filter === "enabled") return enabled(module.id);
    if (filter === "available") return available;
    if (filter === "comingSoon") return !available;
    return true;
  });

  function toggle(module: ModuleDefinition) {
    const on = !enabled(module.id);
    setEnabled(module.id, on);
    setStatus(t(on ? "modules.library.savedOn" : "modules.library.savedOff", { name: x.names[module.id] }));
  }

  return (
    <>
      <PageHeading eyebrow={x.library.eyebrow} title={x.library.title} />
      <p className="bw-muted">{x.library.intro}</p>
      <div className="bw-library-toolbar">
        <div className="bw-segmented" role="group" aria-label={x.library.filtersLabel}>
          {FILTERS.map((key) => (
            <button key={key} type="button" className={filter === key ? "is-active" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}>{x.library.filters[key]}</button>
          ))}
        </div>
        <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      </div>
      {shown.length === 0 ? <p className="bw-muted">{x.library.empty}</p> : (
        <ul className="bw-library-grid" role="list" id="feature-library">
          {shown.map((module) => {
            const available = isAvailable(module, "app");
            const on = enabled(module.id);
            const name = x.names[module.id];
            return (
              <li key={module.id} className={`bw-library-card${on ? " is-on" : ""}${available ? "" : " is-coming-soon"}`} data-module={module.id}>
                <div className="bw-library-card-head">
                  <span className="bw-library-icon"><ModuleIcon name={module.icon} size={22} /></span>
                  <div className="bw-library-title">
                    <h2 id={`module-${module.id}-name`}>{name}</h2>
                    <span className="bw-library-badges">
                      {module.core && <span className="bw-badge bw-badge-quiet">{x.status.core}</span>}
                      <span className={`bw-badge ${available ? "bw-badge-available" : "bw-badge-soon"}`}>{available ? x.status.available : x.status.comingSoon}</span>
                    </span>
                  </div>
                  <button type="button" className="bw-switch" role="switch" aria-checked={on} disabled={!available}
                    aria-labelledby={`module-${module.id}-name`} aria-describedby={`module-${module.id}-desc`} title={t("modules.library.toggleLabel", { name })}
                    onClick={() => toggle(module)}>
                    <span className="bw-switch-track" aria-hidden="true"><span className="bw-switch-thumb" /></span>
                    {available && <span className="bw-switch-text">{on ? x.status.on : x.status.off}</span>}
                  </button>
                </div>
                <p id={`module-${module.id}-desc`} className="bw-library-desc">
                  {x.descriptions[module.id]}
                  {!available && <span className="bw-library-note">{x.library.comingSoonNote}</span>}
                </p>
                {available && on && <p className="bw-library-open"><button type="button" className="bw-link-button" onClick={() => open(module)}>{x.library.openModule}</button></p>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="bw-library-notes">
        <p className="bw-caption">{x.library.settingsNote}</p>
        <p className="bw-caption">{x.library.dataNote}</p>
        <p className="bw-caption">{x.library.syncNote}</p>
      </div>
    </>
  );
}
