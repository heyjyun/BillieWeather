// Settings › Feature Library & sidebar, and the per-feature settings area.
import { moduleById, MODULES } from "@billie/shared-types";
import { useI18n } from "../i18n";
import { FeatureManager } from "../pages/FeatureLibrary";
import type { SectionProps } from "./registry";

export function FeatureLibrarySection({ shell }: SectionProps) {
  return <FeatureManager embedded open={shell?.openModule} openLibrary={shell ? () => shell.go("features") : undefined} />;
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
