// Shown instead of a page whose module is not built for the app (coming soon, or website-only).
// A sidebar choice never leads here: every available module opens whether or not it is in the sidebar.
import { alternateSurface, availabilityOf, type ModuleDefinition } from "@billie/shared-types";
import { useFocusWhenLost } from "../hooks/useFocus";
import { useI18n } from "../i18n";
import { websiteUrl } from "../services/account";
import { openExternal } from "../services/session";
import { ModuleIcon } from "./ModuleIcon";

// Website pages of modules that are built only for the website (module-catalog.json "unsupported" in the app).
const WEBSITE_PAGES: Partial<Record<ModuleDefinition["id"], "/app/forecast">> = { forecast: "/app/forecast" };

/** The website page of a module that only works there, or null. */
export function websitePathFor(module: ModuleDefinition): "/app/forecast" | null {
  return alternateSurface(module, "app") === "web" ? WEBSITE_PAGES[module.id] ?? null : null;
}

export function ModuleUnavailable({ module, openLibrary }: { module: ModuleDefinition; openLibrary: () => void }) {
  const { m, t, locale } = useI18n();
  const name = m.modules.names[module.id];
  const heading = useFocusWhenLost<HTMLHeadingElement>(module.id);
  const web = websitePathFor(module);
  return (
    <section className="bw-panel bw-module-disabled" id="module-unavailable" data-module={module.id} data-availability={availabilityOf(module, "app")}>
      <span className="bw-library-icon"><ModuleIcon name={module.icon} size={26} /></span>
      <span className="bw-eyebrow">{m.modules.unavailable.eyebrow}</span>
      <h1 ref={heading} tabIndex={-1}>{t("modules.unavailable.title", { name })}</h1>
      <p className="bw-muted">{web ? m.modules.library.unsupportedNote : m.modules.library.comingSoonNote}</p>
      <div className="bw-db-actions">
        {web && <button type="button" className="bw-button bw-button-dark" onClick={() => openExternal(websiteUrl(web, locale))}>{m.modules.library.openOnWeb} ↗</button>}
        <button type="button" className="bw-button bw-button-outline" onClick={openLibrary}>{m.modules.library.open}</button>
      </div>
    </section>
  );
}
