/**
 * Feature Library choices in the apps, kept on this device per account (localStorage, like the theme
 * and the database registry), so they survive restarts and do not depend on which local database is
 * open. Versioned format: packages/shared-types/src/modules.ts (`ModulePreferences`, format 1). Only
 * explicit choices are stored; everything else uses the catalog defaults. Nothing here is sent anywhere
 * (cross-device sync is Phase 1b) and nothing here touches financial data.
 */
import { normalizePreferences, setModuleEnabled, type ModulePreferences } from "@billie/shared-types";

const PREFIX = "billie.modules.v1:";

/** The storage key: one per account (owner key); a device-wide key when signed out or in tests. */
export const preferencesKey = (ownerKey: string | null) => `${PREFIX}${ownerKey ?? "device"}`;

export function loadModulePreferences(ownerKey: string | null): ModulePreferences {
  try {
    const raw = localStorage.getItem(preferencesKey(ownerKey));
    return normalizePreferences(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizePreferences(null); // unreadable storage: defaults, never a crash
  }
}

export function saveModulePreferences(ownerKey: string | null, preferences: ModulePreferences): boolean {
  try {
    localStorage.setItem(preferencesKey(ownerKey), JSON.stringify(preferences));
    return true;
  } catch {
    return false; // storage unavailable: the choice lasts for this session only
  }
}

/** Records one explicit choice for this account and returns the new preferences. */
export function chooseModule(ownerKey: string | null, current: ModulePreferences, id: string, enabled: boolean): ModulePreferences {
  const next = setModuleEnabled(current, id, enabled, "app");
  saveModulePreferences(ownerKey, next);
  return next;
}
