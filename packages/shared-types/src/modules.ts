// The Feature Library (Settings › Feature Library): which product modules a person sees.
// The catalog lives in ../schema/module-catalog.json, which the website reads too
// (app/models/finance/module_catalog.rb). Both sides resolve preferences with the same rules and
// replay the same cases (../fixtures/module-preference-cases.json), so a module is on or off for
// the same reasons everywhere.
//
// Rules:
//   - A module can be on only when it is "available" on this surface ("web" or "app").
//     "coming_soon" modules are shown in the library but never enabled, whatever was stored.
//   - Without a stored choice a module uses its default (Transactions and AI Assistant on, the rest off).
//   - A stored choice wins over the default; unknown module ids are ignored (kept for newer versions).
//   - Settings is a system entry, not a module: always shown, never stored.
//   - Turning a module off only hides it. It never changes or deletes financial data.
import catalog from "../schema/module-catalog.json";

export type Surface = "web" | "app";
export type ModuleAvailability = "available" | "coming_soon";
export type ModuleId =
  | "transactions" | "ai_assistant" | "ledgers" | "accounts" | "categories" | "budgets"
  | "reports" | "recurring" | "goals" | "household" | "forecast" | "multi_currency";

export interface ModuleDefinition {
  id: ModuleId;
  core: boolean;
  defaultEnabled: boolean;
  order: number;
  icon: string;
  availability: Record<Surface, ModuleAvailability>;
  /** Route name on the website, page id in the apps; null when not available there. */
  destination: Record<Surface, string | null>;
  dependsOn: ModuleId[];
}

/** A person's explicit choice for one module. `changedAt` is an ISO time (for Phase 1b merges). */
export interface ModuleChoice { enabled: boolean; changedAt: string }

/** Stored, versioned preferences: only explicit choices; everything else uses the defaults. */
export interface ModulePreferences { format: 1; modules: Partial<Record<string, ModuleChoice>> }

export const MODULE_CATALOG_VERSION: number = catalog.version;
export const PREFERENCE_FORMAT = 1 as const;

export const MODULES: readonly ModuleDefinition[] = catalog.modules
  .map((raw) => ({
    id: raw.id as ModuleId,
    core: raw.core,
    defaultEnabled: raw.default_enabled,
    order: raw.order,
    icon: raw.icon,
    availability: raw.availability as Record<Surface, ModuleAvailability>,
    destination: raw.destination as Record<Surface, string | null>,
    dependsOn: raw.depends_on as ModuleId[],
  }))
  .sort((a, b) => a.order - b.order);

export const SYSTEM_ENTRIES = catalog.system_entries;

export function moduleById(id: string): ModuleDefinition | undefined {
  return MODULES.find((module) => module.id === id);
}

export function isAvailable(module: ModuleDefinition, surface: Surface): boolean {
  return module.availability[surface] === "available";
}

export const emptyPreferences = (): ModulePreferences => ({ format: PREFERENCE_FORMAT, modules: {} });

/** Whether `id` is on for this person on this surface. */
export function isModuleEnabled(id: string, preferences: ModulePreferences | null | undefined, surface: Surface): boolean {
  const module = moduleById(id);
  if (!module || !isAvailable(module, surface)) return false;
  const choice = preferences?.modules?.[id];
  return choice ? choice.enabled === true : module.defaultEnabled;
}

/** The enabled modules on this surface, in catalog order (what the sidebar shows besides Settings). */
export function enabledModules(preferences: ModulePreferences | null | undefined, surface: Surface): ModuleDefinition[] {
  return MODULES.filter((module) => isModuleEnabled(module.id, preferences, surface));
}

export class ModulePreferenceError extends Error {
  constructor(readonly code: "unknown_module" | "coming_soon") {
    super(code);
    this.name = "ModulePreferenceError";
  }
}

/** Records an explicit choice. Refuses unknown modules and ones that are not available here. */
export function setModuleEnabled(preferences: ModulePreferences | null | undefined, id: string, enabled: boolean, surface: Surface, changedAt: string = new Date().toISOString()): ModulePreferences {
  const module = moduleById(id);
  if (!module) throw new ModulePreferenceError("unknown_module");
  if (!isAvailable(module, surface)) throw new ModulePreferenceError("coming_soon");
  const base = normalizePreferences(preferences);
  return { format: PREFERENCE_FORMAT, modules: { ...base.modules, [id]: { enabled, changedAt } } };
}

/**
 * Reads stored preferences of any shape safely: wrong or missing data becomes "no choice" (the
 * defaults), never an error that would block the app. Unknown ids are kept untouched.
 */
export function normalizePreferences(value: unknown): ModulePreferences {
  if (!value || typeof value !== "object") return emptyPreferences();
  const raw = value as { format?: unknown; modules?: unknown };
  if (raw.format !== PREFERENCE_FORMAT || !raw.modules || typeof raw.modules !== "object") return emptyPreferences();
  const modules: Record<string, ModuleChoice> = {};
  for (const [id, choice] of Object.entries(raw.modules as Record<string, unknown>)) {
    if (!/^[a-z_]{2,40}$/.test(id) || !choice || typeof choice !== "object") continue;
    const { enabled, changedAt } = choice as { enabled?: unknown; changedAt?: unknown };
    if (typeof enabled !== "boolean") continue;
    modules[id] = { enabled, changedAt: typeof changedAt === "string" ? changedAt : "" };
  }
  return { format: PREFERENCE_FORMAT, modules };
}
