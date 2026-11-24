// Feature Library state for the app shell. Independent of Default / Manual Mode (useMode): the mode
// only changes what pages offer; the modules decide what the sidebar shows and which pages open.
import { enabledModules, isModuleEnabled, MODULES, type ModuleDefinition, type ModulePreferences } from "@billie/shared-types";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { chooseModule, loadModulePreferences } from "../services/modulePreferences";

interface ModulesContextValue {
  preferences: ModulePreferences;
  enabled: (id: string) => boolean;
  enabledList: ModuleDefinition[];
  setEnabled: (id: string, on: boolean) => void;
}

const ModulesContext = createContext<ModulesContextValue | null>(null);

// Rendered on their own (tests, previews), pages behave as if every module were on.
const fallback: ModulesContextValue = { preferences: { format: 1, modules: {} }, enabled: () => true, enabledList: [...MODULES], setEnabled: () => undefined };

export function ModulesProvider({ ownerKey, children }: { ownerKey: string | null; children: ReactNode }) {
  const [preferences, setPreferences] = useState<ModulePreferences>(() => loadModulePreferences(ownerKey));
  const enabled = useCallback((id: string) => isModuleEnabled(id, preferences, "app"), [preferences]);
  const setEnabled = useCallback((id: string, on: boolean) => setPreferences((current) => chooseModule(ownerKey, current, id, on)), [ownerKey]);
  const value = useMemo(() => ({ preferences, enabled, enabledList: enabledModules(preferences, "app"), setEnabled }), [preferences, enabled, setEnabled]);
  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): ModulesContextValue {
  return useContext(ModulesContext) ?? fallback;
}
