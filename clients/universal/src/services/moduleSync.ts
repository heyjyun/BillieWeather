import { isAvailable, moduleById, type ModulePreferences } from "@billie/shared-types";
import { randomId } from "./ids";

export interface ServerChoice {
  enabled: boolean;
  revision: number;
  changed_at: string | null;
  updated_by_device_id: string | null;
}

export interface ModuleSnapshot {
  format: 2;
  account_id: string;
  server_revision: number;
  defaults_version: number;
  modules: Record<string, ServerChoice>;
}

export interface ModuleMutation {
  format: 2;
  device_id: string;
  mutation_id: string;
  base_server_revision: number;
  changes: { module_key: string; enabled: boolean; expected_revision: number }[];
}

export interface MutationResult extends ModuleSnapshot {
  applied: string[];
  conflicts: { module_key: string; proposed_enabled: boolean; current: ServerChoice }[];
}

interface PendingChoice {
  id: string;
  moduleKey: string;
  enabled: boolean;
  expected: number;
  request?: ModuleMutation;
}

export interface ModuleConflict {
  enabled: boolean;
  kind: "local_only" | "different";
}

export interface ModuleReplica {
  format: 2;
  accountId: string;
  deviceId: string;
  snapshot: ModuleSnapshot | null;
  initial: ModulePreferences;
  pending: PendingChoice[];
  conflicts: Record<string, ModuleConflict>;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const moduleKey = /^[a-z_]{2,40}$/;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function available(id: string): boolean {
  const definition = moduleById(id);
  return !!definition && isAvailable(definition, "app");
}

export function serverChoice(value: unknown): value is ServerChoice {
  if (!value || typeof value !== "object") return false;
  const choice = value as ServerChoice;
  return typeof choice.enabled === "boolean" && revision(choice.revision)
    && (choice.changed_at === null || typeof choice.changed_at === "string")
    && (choice.updated_by_device_id === null || typeof choice.updated_by_device_id === "string");
}

export function isSnapshot(value: unknown, accountId: string): value is ModuleSnapshot {
  if (!value || typeof value !== "object") return false;
  const view = value as ModuleSnapshot;
  return view.format === 2 && view.account_id === accountId && revision(view.server_revision) && revision(view.defaults_version)
    && !!view.modules && !Array.isArray(view.modules) && typeof view.modules === "object"
    && Object.entries(view.modules).every(([id, choice]) => moduleKey.test(id) && serverChoice(choice) && choice.revision > 0);
}

export const replicaKey = (accountId: string) => "billie.modules.v2:" + accountId;

function validPending(item: PendingChoice, deviceId: string): boolean {
  if (!item || !uuid.test(item.id) || !available(item.moduleKey) || typeof item.enabled !== "boolean" || !revision(item.expected)) return false;
  if (item.request === undefined) return true;
  const request = item.request;
  if (!request || request.format !== 2 || request.mutation_id !== item.id || request.device_id !== deviceId
    || !revision(request.base_server_revision) || !Array.isArray(request.changes) || request.changes.length !== 1) return false;
  const change = request.changes[0];
  return !!change && change.module_key === item.moduleKey && change.enabled === item.enabled && change.expected_revision === item.expected;
}

export function loadReplica(accountId: string, initial: ModulePreferences): ModuleReplica {
  try {
    const raw = localStorage.getItem(replicaKey(accountId));
    if (raw) {
      const saved = JSON.parse(raw) as ModuleReplica;
      if (saved?.format === 2 && saved.accountId === accountId && uuid.test(saved.deviceId)
        && (saved.snapshot === null || isSnapshot(saved.snapshot, accountId)) && Array.isArray(saved.pending)
        && saved.pending.every((item) => validPending(item, saved.deviceId))
        && saved.conflicts && Object.entries(saved.conflicts).every(([id, conflict]) =>
          available(id) && !!conflict && typeof conflict.enabled === "boolean" && ["local_only", "different"].includes(conflict.kind))) {
        return { ...saved, initial };
      }
    }
  } catch {
    // Keep the older cache available if format 2 cannot be read.
  }
  return { format: 2, accountId, deviceId: randomId(), snapshot: null, initial, pending: [], conflicts: {} };
}

export function saveReplica(state: ModuleReplica): boolean {
  try {
    localStorage.setItem(replicaKey(state.accountId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function displayedPreferences(state: ModuleReplica): ModulePreferences {
  const remembered = Object.entries(state.initial.modules).filter(([id]) => !state.snapshot || !available(id));
  const remote = Object.entries(state.snapshot?.modules ?? {}).map(([id, choice]) =>
    [id, { enabled: choice.enabled, changedAt: choice.changed_at ?? "" }] as const);
  const modules: ModulePreferences["modules"] = Object.fromEntries([...remembered, ...remote]);
  for (const [id, conflict] of Object.entries(state.conflicts)) {
    modules[id] = { enabled: conflict.enabled, changedAt: "" };
  }
  for (const item of state.pending) modules[item.moduleKey] = { enabled: item.enabled, changedAt: "" };
  return { format: 1, modules };
}

export function observeSnapshot(state: ModuleReplica, snapshot: ModuleSnapshot): ModuleReplica {
  if (!isSnapshot(snapshot, state.accountId) || (state.snapshot && state.snapshot.server_revision > snapshot.server_revision)) return state;
  if (state.snapshot) return { ...state, snapshot };

  const conflicts: ModuleReplica["conflicts"] = {};
  for (const [id, local] of Object.entries(displayedPreferences(state).modules)) {
    if (!local || !available(id)) continue;
    const server = snapshot.modules[id];
    if (!server) conflicts[id] = { enabled: local.enabled, kind: "local_only" };
    else if (server.enabled !== local.enabled) conflicts[id] = { enabled: local.enabled, kind: "different" };
  }
  // Before the first GET, queued intents have no observed server revision. Fold them into the
  // first-sync decision instead of guessing that a revision-zero write is authorized.
  return { ...state, snapshot, pending: [], conflicts };
}

export function enqueuePreference(state: ModuleReplica, id: string, enabled: boolean): ModuleReplica {
  if (!available(id) || state.conflicts[id]) return state;
  const last = [...state.pending].reverse().find((item) => item.moduleKey === id);
  const expected = last ? last.expected + (last.request ? 1 : 0) : state.snapshot?.modules[id]?.revision ?? 0;
  const pending = state.pending.filter((item) => item.moduleKey !== id || item.request);
  return { ...state, pending: [...pending, { id: randomId(), moduleKey: id, enabled, expected }] };
}

export function resolvePreference(state: ModuleReplica, id: string, keepLocal: boolean): ModuleReplica {
  const conflict = state.conflicts[id];
  if (!conflict || !state.snapshot) return state;
  const conflicts = { ...state.conflicts };
  delete conflicts[id];
  const next = { ...state, conflicts };
  return keepLocal ? enqueuePreference(next, id, conflict.enabled) : next;
}

export function freezeMutation(state: ModuleReplica): ModuleReplica {
  const first = state.pending[0];
  if (!state.snapshot || !first || first.request) return state;
  const request: ModuleMutation = {
    format: 2, device_id: state.deviceId, mutation_id: first.id, base_server_revision: state.snapshot.server_revision,
    changes: [{ module_key: first.moduleKey, enabled: first.enabled, expected_revision: first.expected }],
  };
  return { ...state, pending: [{ ...first, request }, ...state.pending.slice(1)] };
}

export function acknowledgeMutation(state: ModuleReplica, id: string, result: MutationResult): ModuleReplica {
  const first = state.pending[0];
  if (!first || first.id !== id || !isSnapshot(result, state.accountId)) throw new Error("Unmatched module preference response");
  if (!Array.isArray(result.applied) || !Array.isArray(result.conflicts)) throw new Error("Invalid module preference response");
  const conflict = result.conflicts.find((item) => item?.module_key === first.moduleKey);
  if (conflict ? conflict.proposed_enabled !== first.enabled || !serverChoice(conflict.current) : !result.applied.includes(first.moduleKey)) {
    throw new Error("Unacknowledged module preference");
  }
  const next = observeSnapshot(state, result);
  const remaining = state.pending.slice(1);
  if (!conflict) return { ...next, pending: remaining };
  const preferred = [...state.pending].reverse().find((item) => item.moduleKey === first.moduleKey) ?? first;
  return {
    ...next,
    pending: remaining.filter((item) => item.moduleKey !== first.moduleKey),
    conflicts: { ...state.conflicts, [first.moduleKey]: { enabled: preferred.enabled, kind: "different" } },
  };
}
