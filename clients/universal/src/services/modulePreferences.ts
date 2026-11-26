/**
 * Sidebar choices from the Feature Library, kept on this device per account (localStorage, like the
 * theme and the database registry), so they survive restarts and do not depend on which local database
 * is open. Versioned format: packages/shared-types/src/modules.ts (`ModulePreferences`, format 1;
 * choices saved with the older key `enabled` are read as the same sidebar choice). Only explicit
 * choices are stored; everything else uses the catalog defaults. These choices never decide whether a
 * feature works, and nothing here touches financial data. Cross-device sync: services/moduleSync.ts.
 */
import { normalizePreferences, setSidebarVisible, type ModulePreferences } from "@billie/shared-types";

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

/** Records one explicit sidebar choice for this account and returns the new preferences. */
export function chooseSidebar(ownerKey: string | null, current: ModulePreferences, id: string, visible: boolean): ModulePreferences {
  const next = setSidebarVisible(current, id, visible, "app");
  saveModulePreferences(ownerKey, next);
  return next;
}
