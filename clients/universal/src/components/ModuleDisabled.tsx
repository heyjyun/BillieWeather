// Shown instead of a page whose module is turned off (a typed command, a deep link, a stale button).
// Nothing is changed or deleted; the person can turn the module on here.
import { isAvailable, type ModuleDefinition } from "@billie/shared-types";
import { useFocusWhenLost } from "../hooks/useFocus";
import { useModules } from "../hooks/useModules";
import { useI18n } from "../i18n";
import { ModuleIcon } from "./ModuleIcon";

export function ModuleDisabled({ module, openLibrary }: { module: ModuleDefinition; openLibrary: () => void }) {
  const { m, t } = useI18n();
  const { setEnabled } = useModules();
  const name = m.modules.names[module.id];
  const heading = useFocusWhenLost<HTMLHeadingElement>(module.id);
  return (
    <section className="bw-panel bw-module-disabled" id="module-disabled" data-module={module.id}>
      <span className="bw-library-icon"><ModuleIcon name={module.icon} size={26} /></span>
      <span className="bw-eyebrow">{m.modules.disabled.eyebrow}</span>
      <h1 ref={heading} tabIndex={-1}>{t("modules.disabled.title", { name })}</h1>
      <p className="bw-muted">{m.modules.disabled.body}</p>
      <div className="bw-db-actions">
        {isAvailable(module, "app") && <button type="button" className="bw-button bw-button-dark" onClick={() => setEnabled(module.id, true)}>{t("modules.disabled.turnOn", { name })}</button>}
        <button type="button" className="bw-button bw-button-outline" onClick={openLibrary}>{m.modules.library.open}</button>
      </div>
    </section>
  );
}
