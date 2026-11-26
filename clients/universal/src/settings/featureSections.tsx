// Settings › Feature Library & sidebar, and the per-feature settings area.
import { alternateSurface, moduleById, MODULES } from "@billie/shared-types";
import { websitePathFor } from "../components/ModuleUnavailable";
import { useModules } from "../hooks/useModules";
import { useI18n } from "../i18n";
import { websiteUrl } from "../services/account";
import { openExternal } from "../services/session";
import type { SectionProps } from "./registry";

export function FeatureLibrarySection({ shell }: SectionProps) {
  const { m, locale } = useI18n();
  const { sidebarList, hiddenList } = useModules();
  const h = m.settingsHub.features;
  const elsewhere = MODULES.filter((module) => alternateSurface(module, "app") === "web" && websitePathFor(module));
  return (
    <section className="bw-panel" id="settings-feature-library" aria-labelledby="settings-library-heading">
      <h2 id="settings-library-heading">{m.modules.library.title}</h2>
      <p className="bw-muted">{m.modules.library.intro}</p>
      <dl className="bw-db-facts">
        <div><dt>{h.inSidebar}</dt><dd data-sidebar-list>{[...sidebarList.map((module) => m.modules.names[module.id]), m.modules.nav.settings].join(" · ")}</dd></div>
      </dl>
      {hiddenList.length === 0 ? <p className="bw-caption">{h.noHidden}</p> : (
        <>
          <p className="bw-caption">{h.hiddenIntro}</p>
          <ul className="bw-inline-links" id="settings-hidden-modules">
            {hiddenList.map((module) => (
              <li key={module.id} data-hidden-module={module.id}>
                {shell ? <button type="button" className="bw-link-button" onClick={() => shell.openModule(module)}>{m.modules.names[module.id]}</button> : <span>{m.modules.names[module.id]}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {elsewhere.length > 0 && (
        <p className="bw-caption" id="settings-website-only">
          {h.elsewhere}{" "}
          {elsewhere.map((module) => (
            <button key={module.id} type="button" className="bw-link-button" data-website-module={module.id} onClick={() => openExternal(websiteUrl(websitePathFor(module)!, locale))}>{m.modules.names[module.id]} ↗</button>
          ))}
        </p>
      )}
      {shell && <div className="bw-db-actions"><button type="button" className="bw-button bw-button-dark" onClick={() => shell.go("features")}>{m.modules.library.open}</button></div>}
    </section>
  );
}

type ModuleWithSettings = "accounts" | "categories" | "budgets" | "recurring";

export function ModuleSettingsSection({ shell, module }: SectionProps & { module: ModuleWithSettings }) {
  const { m } = useI18n();
  const text = m.settingsHub.modules[module];
  const definition = moduleById(module);
  if (!shell || !definition) return null;
  return (
    <section className="bw-panel bw-settings-module" aria-labelledby={`settings-module-${module}`} data-settings-module={module}>
      <h3 id={`settings-module-${module}`}>{m.modules.names[module]}</h3>
      <p className="bw-caption">{text.body}</p>
      <div className="bw-db-actions"><button type="button" className="bw-button bw-button-outline bw-button-small" onClick={() => shell.openModule(definition)}>{text.action}</button></div>
    </section>
  );
}

export function AutomationSection({ shell }: SectionProps) {
  const { m } = useI18n();
  if (!shell) return null;
  const features = MODULES.filter((module) => ["ai_assistant", "categories", "recurring"].includes(module.id) && module.availability.app === "available");
  return (
    <section className="bw-panel" id="settings-automation" aria-labelledby="settings-automation-heading">
      <h2 id="settings-automation-heading">{m.modules.automation}</h2>
      <ul className="bw-inline-links">
        {features.map((module) => (
          <li key={module.id}>
            <button type="button" className="bw-link-button" onClick={() => shell.openModule(module)}>{m.modules.names[module.id]}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
