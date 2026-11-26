// Feature Library state is independent of the interface mode and the active ledger.
import { enabledModules, isModuleEnabled, type ModuleDefinition, type ModulePreferences } from "@billie/shared-types";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ModulePreferenceRequestError, fetchModulePreferences, putModulePreferences } from "../services/modulePreferenceApi";
import { chooseModule, loadModulePreferences, saveModulePreferences } from "../services/modulePreferences";
import {
  acknowledgeMutation, displayedPreferences, enqueuePreference, freezeMutation, isSnapshot, loadReplica,
  observeSnapshot, resolvePreference, saveReplica, type ModuleConflict, type ModuleReplica,
} from "../services/moduleSync";

type SyncStatus = "local" | "synced" | "pending" | "error" | "storage_error";

interface ModulesContextValue {
  preferences: ModulePreferences;
  enabled: (id: string) => boolean;
  enabledList: ModuleDefinition[];
  setEnabled: (id: string, on: boolean) => void;
  status: SyncStatus;
  conflicts: Record<string, ModuleConflict>;
  serverEnabled: (id: string) => boolean;
  resolve: (id: string, keepLocal: boolean) => void;
}

interface Props {
  ownerKey: string | null;
  accountId?: string | null;
  getToken?: () => string | null;
  offline?: boolean;
  children: ReactNode;
}

const ModulesContext = createContext<ModulesContextValue | null>(null);
// Outside a provider (a page rendered on its own, e.g. in a test) the catalog defaults apply, exactly
// as for a person with no stored choice. "Everything on" here used to hide whether a page works for a
// default account.
const fallback: ModulesContextValue = {
  preferences: { format: 1, modules: {} }, enabled: (id) => isModuleEnabled(id, null, "app"), enabledList: enabledModules(null, "app"),
  setEnabled: () => undefined, status: "local", conflicts: {}, serverEnabled: (id) => isModuleEnabled(id, null, "app"), resolve: () => undefined,
};
const noToken = () => null;
const SYNC_BUILD_ENABLED = import.meta.env.VITE_BILLIE_MODULE_SYNC !== "0";
const POLL_MS = 30_000;

export function ModulesProvider({ ownerKey, accountId, getToken = noToken, offline = false, children }: Props) {
  const [local, setLocal] = useState(() => loadModulePreferences(ownerKey));
  const [replica, setReplica] = useState<ModuleReplica | null>(() => accountId ? loadReplica(accountId, local) : null);
  const current = useRef(replica);
  const wake = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<SyncStatus>(replica?.snapshot ? "synced" : "local");

  const commit = useCallback((next: ModuleReplica): boolean => {
    current.current = next;
    setReplica(next);
    const saved = saveReplica(next);
    if (!saved) setStatus("storage_error");
    // Keep a rollback copy only after the first-sync choices and pending acknowledgments settle.
    if (saved && next.snapshot && !next.pending.length && !Object.keys(next.conflicts).length) {
      saveModulePreferences(ownerKey, displayedPreferences(next));
    }
    return saved;
  }, [ownerKey]);

  const setEnabled = (id: string, on: boolean) => {
    const state = current.current;
    if (!state) return setLocal((previous) => chooseModule(ownerKey, previous, id, on));
    const next = enqueuePreference(state, id, on);
    if (next !== state && commit(next)) setStatus("pending");
    wake.current?.();
  };

  const resolve = (id: string, keepLocal: boolean) => {
    const state = current.current;
    if (state && commit(resolvePreference(state, id, keepLocal))) setStatus("pending");
    wake.current?.();
  };

  useEffect(() => {
    if (!accountId || !SYNC_BUILD_ENABLED) return;
    const owner = accountId;
    const controller = new AbortController();
    const signal = controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let retryCount = 0;
    let rerun = false;

    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!signal.aborted) timer = setTimeout(() => void run(), ms);
    };

    async function run() {
      if (signal.aborted || !current.current) return;
      if (running) {
        rerun = true;
        return;
      }
      clearTimeout(timer);
      let state = current.current;
      const token = getToken();
      if (!token || offline || navigator.onLine === false) {
        if (state.pending.length) setStatus("pending");
        return;
      }
      const active = () => !signal.aborted && getToken() === token;
      running = true;
      let next = POLL_MS;
      try {
        if (!state.snapshot) {
          const remote = await fetchModulePreferences(token, signal);
          if (!active()) return;
          if (!isSnapshot(remote, owner)) throw new Error("Wrong module preference account");
          state = observeSnapshot(current.current!, remote);
          if (!commit(state)) return;
          if (!state.pending.length) {
            setStatus("synced");
            retryCount = 0;
            return;
          }
        }
        while (state.pending.length && active()) {
          state = freezeMutation(state);
          const item = state.pending[0];
          if (!item?.request || !commit(state)) return;
          const reply = await putModulePreferences(token, item.request, signal);
          if (!active()) return;
          state = acknowledgeMutation(current.current!, item.id, reply);
          if (!commit(state)) return;
        }
        const remote = await fetchModulePreferences(token, signal);
        if (!active()) return;
        if (!isSnapshot(remote, owner)) throw new Error("Wrong module preference account");
        state = observeSnapshot(current.current!, remote);
        if (commit(state)) setStatus(state.pending.length ? "pending" : "synced");
        retryCount = 0;
      } catch (error) {
        if (!active()) return;
        if (error instanceof ModulePreferenceRequestError && error.status === 404) {
          if (!state.snapshot) saveModulePreferences(ownerKey, displayedPreferences(current.current!));
          setStatus(state.snapshot ? "pending" : "local");
        } else {
          setStatus("error");
          if (!(error instanceof ModulePreferenceRequestError) || ![401, 409, 422].includes(error.status ?? 0)) {
            retryCount += 1;
            next = Math.min(60_000, 1_000 * (2 ** Math.min(retryCount, 6))) + Math.random() * 500;
          }
        }
      } finally {
        running = false;
        if (active()) schedule(rerun ? 0 : next);
        rerun = false;
      }
    }

    const trigger = () => { void run(); };
    const foreground = () => { if (document.visibilityState === "visible") trigger(); };
    wake.current = trigger;
    window.addEventListener("online", trigger);
    document.addEventListener("visibilitychange", foreground);
    trigger();
    return () => {
      controller.abort();
      clearTimeout(timer);
      wake.current = null;
      window.removeEventListener("online", trigger);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [accountId, commit, getToken, offline, ownerKey]);

  const preferences = replica ? displayedPreferences(replica) : local;
  const enabled = (id: string) => isModuleEnabled(id, preferences, "app");
  const serverEnabled = (id: string) => replica?.snapshot?.modules[id]?.enabled ?? isModuleEnabled(id, null, "app");
  return (
    <ModulesContext.Provider value={{
      preferences, enabled, enabledList: enabledModules(preferences, "app"), setEnabled, status,
      conflicts: replica?.conflicts ?? {}, resolve, serverEnabled,
    }}>
      {children}
    </ModulesContext.Provider>
  );
}

export function useModules(): ModulesContextValue {
  return useContext(ModulesContext) ?? fallback;
}
