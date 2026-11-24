// @vitest-environment jsdom
// The Feature Library catalog contract on the app side (packages/shared-types/src/modules.ts). The
// website replays the same cases (test/models/finance/module_catalog_test.rb).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enabledModules, isModuleEnabled, MODULES, ModulePreferenceError, normalizePreferences, setModuleEnabled, type Surface } from "@billie/shared-types";
import { chooseModule, loadModulePreferences, preferencesKey, saveModulePreferences } from "../src/services/modulePreferences";
import { PAGE_MODULES } from "../src/App";

const CASES = JSON.parse(readFileSync(join(__dirname, "../../../packages/shared-types/fixtures/module-preference-cases.json"), "utf8")).cases as Array<{ name: string; surface: Surface; preferences: unknown; enabled: string[] }>;

describe("module catalog", () => {
  it.each(CASES.map((example) => [example.name, example] as const))("shared case: %s", (_name, example) => {
    expect(enabledModules(normalizePreferences(example.preferences), example.surface).map((module) => module.id)).toEqual(example.enabled);
  });

  it("starts with Transactions and AI Assistant only; Settings is not a module", () => {
    expect(MODULES.filter((module) => module.defaultEnabled).map((module) => module.id)).toEqual(["transactions", "ai_assistant"]);
    expect(MODULES.map((module) => module.id)).not.toContain("settings");
  });

  it("refuses unknown and coming-soon modules; a choice is versioned and dated", () => {
    expect(() => setModuleEnabled(null, "goals", true, "app")).toThrow(ModulePreferenceError);
    expect(() => setModuleEnabled(null, "forecast", true, "app")).toThrow(ModulePreferenceError); // web only for now
    expect(() => setModuleEnabled(null, "settings", false, "app")).toThrow(ModulePreferenceError);
    const next = setModuleEnabled(null, "budgets", true, "app", "2026-11-23T10:00:00.000Z");
    expect(next).toEqual({ format: 1, modules: { budgets: { enabled: true, changedAt: "2026-11-23T10:00:00.000Z" } } });
    expect(isModuleEnabled("budgets", next, "app")).toBe(true);
    expect(isModuleEnabled("budgets", setModuleEnabled(next, "budgets", false, "app"), "app")).toBe(false);
  });

  it("every app destination is a page, and every page that belongs to a module names a real module", () => {
    const pages = Object.keys(PAGE_MODULES);
    for (const module of MODULES) {
      if (module.availability.app === "available") expect(pages, module.id).toContain(module.destination.app);
      else expect(module.destination.app, module.id).toBeNull();
    }
    const ids = new Set(MODULES.map((module) => module.id));
    for (const modules of Object.values(PAGE_MODULES)) for (const id of modules) expect(ids.has(id)).toBe(true);
    // System pages stay open whatever is turned off.
    expect(PAGE_MODULES.settings).toEqual([]);
    expect(PAGE_MODULES.data).toEqual([]);
    expect(PAGE_MODULES.features).toEqual([]);
  });
});

describe("module preferences on this device", () => {
  beforeEach(() => localStorage.clear());

  it("persist per account across restarts and never leak to another account", () => {
    const first = chooseModule("id:a", loadModulePreferences("id:a"), "reports", true);
    expect(isModuleEnabled("reports", first, "app")).toBe(true);
    expect(isModuleEnabled("reports", loadModulePreferences("id:a"), "app")).toBe(true); // a restart reads it back
    expect(isModuleEnabled("reports", loadModulePreferences("id:b"), "app")).toBe(false);
    expect(Object.keys(localStorage)).toEqual([preferencesKey("id:a")]);
  });

  it("treat unreadable or foreign data as defaults instead of failing", () => {
    localStorage.setItem(preferencesKey("id:a"), "{not json");
    expect(enabledModules(loadModulePreferences("id:a"), "app").map((module) => module.id)).toEqual(["transactions", "ai_assistant"]);
    localStorage.setItem(preferencesKey("id:a"), JSON.stringify({ format: 7, modules: { reports: { enabled: true } } }));
    expect(isModuleEnabled("reports", loadModulePreferences("id:a"), "app")).toBe(false);
    expect(saveModulePreferences("id:a", normalizePreferences(null))).toBe(true);
  });
});
