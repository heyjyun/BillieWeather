// Settings: BillieWeather's configuration and management centre. It has no sections of its own: it
// renders the Settings section registry (settings/registry.tsx), grouped by area, with an index at
// the top. Settings is always in the sidebar.
import type { ModuleDefinition } from "@billie/shared-types";
import { Fragment, useEffect } from "react";
import { PageHeading } from "../components/common";
import { useI18n } from "../i18n";
import { areaAnchor, visibleSections, type Go, type SettingsShell } from "../settings/registry";

const jump = (id: string) => document.getElementById(id)?.scrollIntoView?.({ block: "start" });

export function Settings({ go, openModule, focus }: { go?: Go; openModule?: (module: ModuleDefinition) => void; focus?: string | null } = {}) {
  const { m } = useI18n();
  const x = m.settings;
  const h = m.settingsHub;
  const shell: SettingsShell | null = go && openModule ? { go, openModule } : null;
  const groups = visibleSections(shell !== null);

  useEffect(() => {
    if (focus === "account") jump(areaAnchor("account"));
  }, [focus]);

  return (
    <>
      <PageHeading eyebrow={x.eyebrow} title={x.title} />
      <div className="bw-settings-index" role="group" aria-label={h.indexLabel} id="settings-index">
        {groups.map(({ area }) => (
          <button key={area} type="button" className="bw-link-button" data-settings-area={area} onClick={() => jump(areaAnchor(area))}>{h.areas[area]}</button>
        ))}
      </div>
      {groups.map(({ area, sections }) => (
        <div key={area} id={areaAnchor(area)} className="bw-settings-area" data-settings-area={area}>
          {area === "modules" ? (
            <section className="bw-panel" aria-labelledby="settings-modules-heading">
              <h2 id="settings-modules-heading">{h.areas.modules}</h2>
              <p className="bw-caption">{h.modules.intro}</p>
              <div className="bw-settings-module-grid">
                {sections.map((section) => <Fragment key={section.id}>{section.render({ shell })}</Fragment>)}
              </div>
            </section>
          ) : sections.map((section) => <Fragment key={section.id}>{section.render({ shell })}</Fragment>)}
        </div>
      ))}
    </>
  );
}
