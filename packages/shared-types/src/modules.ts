// The Feature Library (Settings › Feature Library): what BillieWeather offers and what the sidebar shows.
// The catalog lives in ../schema/module-catalog.json, which the website reads too
// (app/models/finance/module_catalog.rb). Both sides resolve preferences with the same rules and
// replay the same cases (../fixtures/module-preference-cases.json).
//
// Three separate questions, never mixed:
//   1. Availability (per surface, "web" or "app"): "available" = built and works there;
//      "coming_soon" = not built yet; "unsupported" = built on another surface, not on this one.
//   2. Enabled = can be used. Derived, never stored: a module available on a surface is enabled there,
//      for new and existing accounts alike. No personal choice disables a feature.
//   3. Sidebar visibility = whether the module has a sidebar entry. A personal choice; without one
//      the catalog default applies (Transactions, AI Insight, Financial Overview, Categories,
//      Accounts & Assets; catalog version 3).
//   4. Sidebar order = the order of the sidebar entries. A personal choice too: one saved list of
//      module ids; entries it does not mention follow it in catalog order (orderSidebar).
//
// Hiding a module from the sidebar never blocks its pages, changes or deletes data, or stops
// processing. Settings is a system entry, not a module: always shown, never stored.
import catalog from "../schema/module-catalog.json";

export type Surface = "web" | "app";
export type ModuleAvailability = "available" | "coming_soon" | "unsupported";
export type ModuleId =
  | "transactions" | "ai_assistant" | "overview" | "import" | "receipts" | "data_management" | "ledgers" | "accounts" | "categories" | "budgets"
  | "reports" | "recurring" | "goals" | "household" | "forecast" | "multi_currency";

export interface ModuleDefinition {
  id: ModuleId;
  core: boolean;
  /** Whether the module is in the sidebar until the person chooses otherwise. Not about whether it works. */
  defaultSidebarVisible: boolean;
  order: number;
  icon: string;
  availability: Record<Surface, ModuleAvailability>;
  /** Route name on the website, page id in the apps; null when not available there. */
  destination: Record<Surface, string | null>;
  dependsOn: ModuleId[];
}

/** A person's explicit sidebar choice for one module. `changedAt` is an ISO time. */
export interface ModuleChoice { sidebarVisible: boolean; changedAt: string }

/**
 * Stored, versioned sidebar preferences: only explicit choices; everything else uses the defaults.
 * Format 1 was first written with the key `enabled`; it meant the same thing (shown in the sidebar)
 * and is still read, so no stored choice is lost. `order` (added 2026-11-28, optional, so format 1
 * still) is the person's saved sidebar order; absent or empty means catalog order.
 */
export interface ModulePreferences { format: 1; modules: Partial<Record<string, ModuleChoice>>; order?: string[] }

export const MODULE_CATALOG_VERSION: number = catalog.version;
export const PREFERENCE_FORMAT = 1 as const;

export const MODULES: readonly ModuleDefinition[] = catalog.modules
  .map((raw) => ({
    id: raw.id as ModuleId,
    core: raw.core,
    defaultSidebarVisible: raw.default_sidebar_visible,
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

export function availabilityOf(module: ModuleDefinition, surface: Surface): ModuleAvailability {
  return module.availability[surface];
}

export function isAvailable(module: ModuleDefinition, surface: Surface): boolean {
  return availabilityOf(module, surface) === "available";
}

/** The other surface where an "unsupported" module works (e.g. Forecast on the website), if any. */
export function alternateSurface(module: ModuleDefinition, surface: Surface): Surface | null {
  const other: Surface = surface === "web" ? "app" : "web";
  return availabilityOf(module, surface) === "unsupported" && isAvailable(module, other) ? other : null;
}

export const emptyPreferences = (): ModulePreferences => ({ format: PREFERENCE_FORMAT, modules: {} });

/** Whether `id` can be used on this surface. True for every available module, whatever the sidebar shows. */
export function isModuleEnabled(id: string, surface: Surface): boolean {
  const module = moduleById(id);
  return !!module && isAvailable(module, surface);
}

/** Every module that can be used on this surface, in catalog order. */
export function enabledModules(surface: Surface): ModuleDefinition[] {
  return MODULES.filter((module) => isAvailable(module, surface));
}

/** Whether `id` has a sidebar entry for this person on this surface. */
export function isInSidebar(id: string, preferences: ModulePreferences | null | undefined, surface: Surface): boolean {
  const module = moduleById(id);
  if (!module || !isAvailable(module, surface)) return false;
  const choice = preferences?.modules?.[id];
  return choice ? choice.sidebarVisible === true : module.defaultSidebarVisible;
}

/**
 * Puts modules in the saved order: those the list names first, in its order (each once), then the rest
 * in catalog order. Ids the list names that are not among `modules` are skipped, so a hidden, unknown
 * or unavailable id never adds an entry, and a module added to the catalog later never moves the
 * modules the person placed. Deterministic for any input.
 */
export function orderSidebar(modules: readonly ModuleDefinition[], order: readonly string[] | null | undefined): ModuleDefinition[] {
  const byId = new Map(modules.map((module) => [module.id as string, module]));
  const placed: ModuleDefinition[] = [];
  for (const id of order ?? []) {
    const module = byId.get(id);
    if (module) {
      placed.push(module);
      byId.delete(id);
    }
  }
  return [...placed, ...modules.filter((module) => byId.has(module.id))];
}

/** The sidebar entries on this surface, in the person's order (Settings is added after them, always). */
export function sidebarModules(preferences: ModulePreferences | null | undefined, surface: Surface): ModuleDefinition[] {
  return orderSidebar(MODULES.filter((module) => isInSidebar(module.id, preferences, surface)), preferences?.order);
}

/**
 * A clean saved order: known module ids only, each once, at most one entry per catalog module. Ids
 * of modules not available here are kept (another surface may show them), like stored choices are.
 */
export function normalizeOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id === "string" && moduleById(id) && !seen.has(id)) seen.add(id);
  }
  return [...seen];
}

/**
 * Saves a new sidebar order (e.g. after a drag). `ids` is the order of the entries the person sees;
 * modules it leaves out keep their place after them. Refuses unknown ids and unavailable modules.
 */
export function setSidebarOrder(preferences: ModulePreferences | null | undefined, ids: readonly string[], surface: Surface): ModulePreferences {
  for (const id of ids) {
    const module = moduleById(id);
    if (!module) throw new ModulePreferenceError("unknown_module");
    if (!isAvailable(module, surface)) throw new ModulePreferenceError("not_available");
  }
  const base = normalizePreferences(preferences);
  return { ...base, order: normalizeOrder(ids) };
}

/** Available modules that are not in the sidebar: still usable, opened from the Feature Library. */
export function hiddenModules(preferences: ModulePreferences | null | undefined, surface: Surface): ModuleDefinition[] {
  return MODULES.filter((module) => isAvailable(module, surface) && !isInSidebar(module.id, preferences, surface));
}

export class ModulePreferenceError extends Error {
  constructor(readonly code: "unknown_module" | "not_available") {
    super(code);
    this.name = "ModulePreferenceError";
  }
}

/** Records an explicit sidebar choice. Refuses unknown modules and ones that are not available here. */
export function setSidebarVisible(preferences: ModulePreferences | null | undefined, id: string, visible: boolean, surface: Surface, changedAt: string = new Date().toISOString()): ModulePreferences {
  const module = moduleById(id);
  if (!module) throw new ModulePreferenceError("unknown_module");
  if (!isAvailable(module, surface)) throw new ModulePreferenceError("not_available");
  const base = normalizePreferences(preferences);
  return { ...base, modules: { ...base.modules, [id]: { sidebarVisible: visible, changedAt } } };
}

/**
 * Reads stored preferences of any shape safely: wrong or missing data becomes "no choice" (the
 * defaults), never an error that would block the app. Unknown ids are kept untouched. The legacy key
 * `enabled` is read as the sidebar choice it always was.
 */
export function normalizePreferences(value: unknown): ModulePreferences {
  if (!value || typeof value !== "object") return emptyPreferences();
  const raw = value as { format?: unknown; modules?: unknown };
  if (raw.format !== PREFERENCE_FORMAT || !raw.modules || typeof raw.modules !== "object") return emptyPreferences();
  const modules: Record<string, ModuleChoice> = {};
  for (const [id, choice] of Object.entries(raw.modules as Record<string, unknown>)) {
    if (!/^[a-z_]{2,40}$/.test(id) || !choice || typeof choice !== "object") continue;
    const { sidebarVisible, enabled, changedAt } = choice as { sidebarVisible?: unknown; enabled?: unknown; changedAt?: unknown };
    const visible = typeof sidebarVisible === "boolean" ? sidebarVisible : enabled;
    if (typeof visible !== "boolean") continue;
    modules[id] = { sidebarVisible: visible, changedAt: typeof changedAt === "string" ? changedAt : "" };
  }
  const order = normalizeOrder((value as { order?: unknown }).order);
  return order.length ? { format: PREFERENCE_FORMAT, modules, order } : { format: PREFERENCE_FORMAT, modules };
}
