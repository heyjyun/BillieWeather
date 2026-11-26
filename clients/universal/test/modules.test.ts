// @vitest-environment jsdom
// The Feature Library catalog contract on the app side (packages/shared-types/src/modules.ts). The
// website replays the same cases (test/models/finance/module_catalog_test.rb).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  alternateSurface, availabilityOf, enabledModules, hiddenModules, isInSidebar, isModuleEnabled, moduleById, MODULES, ModulePreferenceError,
  normalizePreferences, setSidebarVisible, sidebarModules, type Surface,
} from "@billie/shared-types";
import catalog from "../../../packages/shared-types/schema/module-catalog.json";
import { chooseSidebar, loadModulePreferences, preferencesKey, saveModulePreferences } from "../src/services/modulePreferences";
import { PAGE_MODULES } from "../src/App";

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "../../../packages/shared-types/fixtures/module-preference-cases.json"), "utf8")) as {
  usable_by_surface: Record<Surface, string[]>;
  cases: Array<{ name: string; surface: Surface; preferences: unknown; sidebar: string[] }>;
};
const ids = (list: Array<{ id: string }>) => list.map((module) => module.id);

describe("module catalog", () => {
  it.each(FIXTURE.cases.map((example) => [example.name, example] as const))("shared case: %s", (_name, example) => {
    expect(ids(sidebarModules(normalizePreferences(example.preferences), example.surface))).toEqual(example.sidebar);
    // What can be used never depends on sidebar choices.
    expect(ids(enabledModules(example.surface))).toEqual(FIXTURE.usable_by_surface[example.surface]);
  });

  it("starts with Transactions and AI Assistant in the sidebar; Settings is not a module", () => {
    expect(ids(MODULES.filter((module) => module.defaultSidebarVisible))).toEqual(["transactions", "ai_assistant"]);
    expect(MODULES.map((module) => module.id)).not.toContain("settings");
    expect(catalog.modules.every((raw) => !("default_enabled" in raw))).toBe(true);
  });

  it("every built module is usable for a new account; only the sidebar is minimal", () => {
    expect(ids(enabledModules("app"))).toEqual(["transactions", "ai_assistant", "overview", "import", "receipts", "data_management", "accounts", "categories", "budgets", "reports", "recurring"]);
    for (const id of ["accounts", "categories", "budgets", "reports", "recurring"]) {
      expect(isModuleEnabled(id, "app"), id).toBe(true);
      expect(isInSidebar(id, null, "app"), id).toBe(false);
    }
    expect(ids(hiddenModules(null, "app"))).toEqual(["overview", "import", "receipts", "data_management", "accounts", "categories", "budgets", "reports", "recurring"]);
  });

  it("platform status: Forecast is website-only, not 'coming soon' and not switched off", () => {
    const forecast = moduleById("forecast")!;
    expect(availabilityOf(forecast, "app")).toBe("unsupported");
    expect(availabilityOf(forecast, "web")).toBe("available");
    expect(alternateSurface(forecast, "app")).toBe("web");
    expect(isModuleEnabled("forecast", "app")).toBe(false);
    expect(isModuleEnabled("forecast", "web")).toBe(true);
    for (const id of ["ledgers", "goals", "household", "multi_currency"]) {
      const module = moduleById(id)!;
      expect([availabilityOf(module, "app"), availabilityOf(module, "web")], id).toEqual(["coming_soon", "coming_soon"]);
      expect(alternateSurface(module, "app"), id).toBeNull();
    }
  });

  it("refuses unknown and unavailable modules; a choice is versioned and dated", () => {
    expect(() => setSidebarVisible(null, "goals", true, "app")).toThrow(ModulePreferenceError);
    expect(() => setSidebarVisible(null, "forecast", true, "app")).toThrow(ModulePreferenceError); // website only for now
    expect(() => setSidebarVisible(null, "settings", false, "app")).toThrow(ModulePreferenceError);
    const next = setSidebarVisible(null, "budgets", true, "app", "2026-11-23T10:00:00.000Z");
    expect(next).toEqual({ format: 1, modules: { budgets: { sidebarVisible: true, changedAt: "2026-11-23T10:00:00.000Z" } } });
    expect(isInSidebar("budgets", next, "app")).toBe(true);
    const hidden = setSidebarVisible(next, "budgets", false, "app");
    expect(isInSidebar("budgets", hidden, "app")).toBe(false);
    expect(isModuleEnabled("budgets", "app")).toBe(true);
  });

  it("every app destination is a page, and every page that belongs to a module names a real module", () => {
    const pages = Object.keys(PAGE_MODULES);
    for (const module of MODULES) {
      if (module.availability.app === "available") expect(pages, module.id).toContain(module.destination.app);
      else expect(module.destination.app, module.id).toBeNull();
    }
    const known = new Set(MODULES.map((module) => module.id));
    for (const modules of Object.values(PAGE_MODULES)) for (const id of modules) expect(known.has(id)).toBe(true);
    // Every module a page belongs to is usable in the app, so no page is ever blocked by a sidebar choice.
    for (const modules of Object.values(PAGE_MODULES)) for (const id of modules) expect(isModuleEnabled(id, "app"), id).toBe(true);
    expect(PAGE_MODULES.settings).toEqual([]);
    expect(PAGE_MODULES.data).toEqual(["data_management"]);
    expect(PAGE_MODULES.features).toEqual([]);
  });
});

describe("sidebar preferences on this device", () => {
  beforeEach(() => localStorage.clear());

  it("persist per account across restarts and never leak to another account", () => {
    const first = chooseSidebar("id:a", loadModulePreferences("id:a"), "reports", true);
    expect(isInSidebar("reports", first, "app")).toBe(true);
    expect(isInSidebar("reports", loadModulePreferences("id:a"), "app")).toBe(true); // a restart reads it back
    expect(isInSidebar("reports", loadModulePreferences("id:b"), "app")).toBe(false);
    expect(Object.keys(localStorage)).toEqual([preferencesKey("id:a")]);
  });

  it("read choices saved by earlier versions (key `enabled`) without losing them", () => {
    localStorage.setItem(preferencesKey("id:a"), JSON.stringify({ format: 1, modules: { reports: { enabled: true, changedAt: "2026-11-24T00:00:00Z" }, ai_assistant: { enabled: false, changedAt: "" } } }));
    const loaded = loadModulePreferences("id:a");
    expect(ids(sidebarModules(loaded, "app"))).toEqual(["transactions", "reports"]);
    expect(loaded.modules.reports).toEqual({ sidebarVisible: true, changedAt: "2026-11-24T00:00:00Z" });
    expect(isModuleEnabled("ai_assistant", "app")).toBe(true);
  });

  it("treat unreadable or foreign data as defaults instead of failing", () => {
    localStorage.setItem(preferencesKey("id:a"), "{not json");
    expect(ids(sidebarModules(loadModulePreferences("id:a"), "app"))).toEqual(["transactions", "ai_assistant"]);
    localStorage.setItem(preferencesKey("id:a"), JSON.stringify({ format: 7, modules: { reports: { sidebarVisible: true } } }));
    expect(isInSidebar("reports", loadModulePreferences("id:a"), "app")).toBe(false);
    expect(saveModulePreferences("id:a", normalizePreferences(null))).toBe(true);
  });
});
