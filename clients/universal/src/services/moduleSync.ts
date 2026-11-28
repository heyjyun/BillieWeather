// Cross-device sync of sidebar choices (Settings › Feature Library) with the account
// (app/services/finance/module_preference_sync.rb). A choice says whether a module is in the sidebar;
// it never decides whether a feature works.
//
// Wire names: a choice is `sidebar_visible`. Servers and apps released before 2026-11-26 used the
// name `enabled` for the same value, so this file reads either and sends both (always equal).
// Replicas saved on this device by those versions are read the same way.
//
// Sidebar order (2026-11-28): one list per account with its own revision (`sidebar_order`), sent in
// the same mutation format with no module changes. A server that does not report `sidebar_order`
// predates it: the order then stays on this device only. On a revision conflict the account's order
// wins (another device reordered first); this device's attempt is dropped, never forced.
import { enabledModules, isAvailable, moduleById, normalizeOrder, type ModulePreferences } from "@billie/shared-types";
import { randomId } from "./ids";

export interface ServerChoice {
  sidebar_visible?: boolean;
  /** Legacy name of `sidebar_visible` (servers before 2026-11-26). */
  enabled?: boolean;
  revision: number;
  changed_at: string | null;
  updated_by_device_id: string | null;
}

export interface ServerOrder {
  module_keys: string[];
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
  /** The saved sidebar order; null when none was saved. Absent from servers that cannot store one. */
  sidebar_order?: ServerOrder | null;
}

export interface ModuleChange {
  module_key: string;
  sidebar_visible?: boolean;
  /** Sent too, with the same value, so servers before 2026-11-26 understand the change. */
  enabled?: boolean;
  expected_revision: number;
}

export interface ModuleMutation {
  format: 2;
  device_id: string;
  mutation_id: string;
  base_server_revision: number;
  changes: ModuleChange[];
  sidebar_order?: { module_keys: string[]; expected_revision: number };
}

export interface MutationConflict {
  module_key: string;
  proposed_sidebar_visible?: boolean;
  proposed_enabled?: boolean;
  current: ServerChoice;
}

export interface MutationResult extends ModuleSnapshot {
  applied: string[];
  conflicts: MutationConflict[];
  order_applied?: boolean;
  order_conflict?: { proposed_module_keys: string[]; current: ServerOrder | null } | null;
}

interface PendingOrder {
  id: string;
  keys: string[];
  expected: number;
  request?: ModuleMutation;
}

interface PendingChoice {
  id: string;
  moduleKey: string;
  visible: boolean;
  expected: number;
  request?: ModuleMutation;
}

export interface ModuleConflict {
  /** This device's sidebar choice. */
  visible: boolean;
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
  /** Sidebar order changes not yet acknowledged by the account (oldest first). */
  orderPending: PendingOrder[];
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const moduleKey = /^[a-z_]{2,40}$/;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function canSyncChoice(id: string): boolean {
  const definition = moduleById(id);
  return !!definition && isAvailable(definition, "app");
}

/** `sidebar_visible`, or the legacy `enabled`; undefined when neither is a boolean or they disagree. */
function visibility(current: unknown, legacy: unknown): boolean | undefined {
  if (typeof current === "boolean") return typeof legacy === "boolean" && legacy !== current ? undefined : current;
  return typeof legacy === "boolean" ? legacy : undefined;
}

/** The sidebar choice a server reported. Call only on a validated ServerChoice. */
export const serverVisible = (choice: ServerChoice): boolean => visibility(choice.sidebar_visible, choice.enabled) === true;

export function serverChoice(value: unknown): value is ServerChoice {
  if (!value || typeof value !== "object") return false;
  const choice = value as ServerChoice;
  return visibility(choice.sidebar_visible, choice.enabled) !== undefined && revision(choice.revision)
    && (choice.changed_at === null || typeof choice.changed_at === "string")
    && (choice.updated_by_device_id === null || typeof choice.updated_by_device_id === "string");
}

function serverOrder(value: unknown): value is ServerOrder {
  if (!value || typeof value !== "object") return false;
  const order = value as ServerOrder;
  return Array.isArray(order.module_keys) && order.module_keys.every((id) => typeof id === "string" && moduleKey.test(id))
    && revision(order.revision) && order.revision > 0
    && (order.changed_at === null || typeof order.changed_at === "string")
    && (order.updated_by_device_id === null || typeof order.updated_by_device_id === "string");
}

export function isSnapshot(value: unknown, accountId: string): value is ModuleSnapshot {
  if (!value || typeof value !== "object") return false;
  const view = value as ModuleSnapshot;
  return view.format === 2 && view.account_id === accountId && revision(view.server_revision) && revision(view.defaults_version)
    && !!view.modules && !Array.isArray(view.modules) && typeof view.modules === "object"
    && Object.entries(view.modules).every(([id, choice]) => moduleKey.test(id) && serverChoice(choice) && choice.revision > 0)
    && (view.sidebar_order === undefined || view.sidebar_order === null || serverOrder(view.sidebar_order));
}

/** Whether this account's server stores a sidebar order (it reports `sidebar_order`, even as null). */
export const canSyncOrder = (state: ModuleReplica): boolean => !!state.snapshot && "sidebar_order" in state.snapshot;

export const replicaKey = (accountId: string) => "billie.modules.v2:" + accountId;

/** A saved pending choice, from this version (`visible`) or an older one (`enabled`); null if unusable. */
function readPending(raw: unknown, deviceId: string): PendingChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as PendingChoice & { enabled?: unknown };
  const visible = visibility(item.visible, item.enabled);
  if (!uuid.test(item.id) || !moduleKey.test(item.moduleKey) || visible === undefined || !revision(item.expected)) return null;
  const pending: PendingChoice = { id: item.id, moduleKey: item.moduleKey, visible, expected: item.expected };
  if (item.request === undefined) return pending;
  const request = item.request;
  if (!request || request.format !== 2 || request.mutation_id !== item.id || request.device_id !== deviceId
    || !revision(request.base_server_revision) || !Array.isArray(request.changes) || request.changes.length !== 1) return null;
  const change = request.changes[0];
  // A frozen request is resent byte for byte (the server matches retries by content), so it is kept as saved.
  return change && change.module_key === item.moduleKey && visibility(change.sidebar_visible, change.enabled) === visible
    && change.expected_revision === item.expected ? { ...pending, request } : null;
}

function readPendingOrder(raw: unknown, deviceId: string): PendingOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as PendingOrder;
  if (!uuid.test(item.id) || !Array.isArray(item.keys) || !item.keys.every((id) => typeof id === "string" && moduleKey.test(id)) || !revision(item.expected)) return null;
  const pending: PendingOrder = { id: item.id, keys: item.keys, expected: item.expected };
  if (item.request === undefined) return pending;
  const request = item.request;
  return request && request.format === 2 && request.mutation_id === item.id && request.device_id === deviceId && Array.isArray(request.changes)
    && request.changes.length === 0 && request.sidebar_order?.expected_revision === item.expected
    && JSON.stringify(request.sidebar_order.module_keys) === JSON.stringify(item.keys) ? { ...pending, request } : null;
}

function readConflict(raw: unknown): ModuleConflict | null {
  if (!raw || typeof raw !== "object") return null;
  const conflict = raw as ModuleConflict & { enabled?: unknown };
  const visible = visibility(conflict.visible, conflict.enabled);
  return visible !== undefined && (conflict.kind === "local_only" || conflict.kind === "different") ? { visible, kind: conflict.kind } : null;
}

export function loadReplica(accountId: string, initial: ModulePreferences): ModuleReplica {
  try {
    const raw = localStorage.getItem(replicaKey(accountId));
    if (raw) {
      const saved = JSON.parse(raw) as ModuleReplica;
      if (saved?.format === 2 && saved.accountId === accountId && uuid.test(saved.deviceId)
        && (saved.snapshot === null || isSnapshot(saved.snapshot, accountId)) && Array.isArray(saved.pending) && saved.conflicts && typeof saved.conflicts === "object") {
        const pending = saved.pending.map((item) => readPending(item, saved.deviceId));
        const conflicts = Object.entries(saved.conflicts).map(([id, conflict]) => [id, moduleKey.test(id) ? readConflict(conflict) : null] as const);
        // Replicas saved before sidebar order existed have no orderPending: nothing was queued.
        const orderPending = (Array.isArray(saved.orderPending) ? saved.orderPending : []).map((item) => readPendingOrder(item, saved.deviceId));
        if (pending.every((item) => item !== null) && conflicts.every(([, conflict]) => conflict !== null) && orderPending.every((item) => item !== null)) {
          return { ...saved, initial, pending: pending as PendingChoice[], conflicts: Object.fromEntries(conflicts) as Record<string, ModuleConflict>, orderPending: orderPending as PendingOrder[] };
        }
      }
    }
  } catch {
    // Keep the older cache available if format 2 cannot be read.
  }
  return { format: 2, accountId, deviceId: randomId(), snapshot: null, initial, pending: [], conflicts: {}, orderPending: [] };
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
  const remembered = Object.entries(state.initial.modules).filter(([id]) => !state.snapshot || !canSyncChoice(id));
  const remote = Object.entries(state.snapshot?.modules ?? {}).map(([id, choice]) =>
    [id, { sidebarVisible: serverVisible(choice), changedAt: choice.changed_at ?? "" }] as const);
  const modules: ModulePreferences["modules"] = Object.fromEntries([...remembered, ...remote]);
  for (const [id, conflict] of Object.entries(state.conflicts)) {
    modules[id] = { sidebarVisible: conflict.visible, changedAt: "" };
  }
  for (const item of state.pending) modules[item.moduleKey] = { sidebarVisible: item.visible, changedAt: "" };
  const order = displayedOrder(state);
  return order.length ? { format: 1, modules, order } : { format: 1, modules };
}

/** The order to show: the newest queued change, else the account's, else what this device remembered. */
function displayedOrder(state: ModuleReplica): string[] {
  const queued = state.orderPending[state.orderPending.length - 1];
  if (queued) return queued.keys;
  if (canSyncOrder(state)) return normalizeOrder(state.snapshot?.sidebar_order?.module_keys);
  return normalizeOrder(state.initial.order);
}

export function observeSnapshot(state: ModuleReplica, snapshot: ModuleSnapshot): ModuleReplica {
  if (!isSnapshot(snapshot, state.accountId) || (state.snapshot && state.snapshot.server_revision > snapshot.server_revision)) return state;
  if (state.snapshot) return { ...state, snapshot };
  const firstOrder = firstSyncOrder(state, snapshot);

  const conflicts: ModuleReplica["conflicts"] = {};
  for (const [id, local] of Object.entries(displayedPreferences(state).modules)) {
    if (!local || !canSyncChoice(id)) continue;
    const server = snapshot.modules[id];
    if (!server) conflicts[id] = { visible: local.sidebarVisible, kind: "local_only" };
    else if (serverVisible(server) !== local.sidebarVisible) conflicts[id] = { visible: local.sidebarVisible, kind: "different" };
  }
  // Before the first GET, queued intents have no observed server revision. Fold them into the
  // first-sync decision instead of guessing that a revision-zero write is authorized.
  return { ...state, snapshot, pending: state.pending.filter((item) => !canSyncChoice(item.moduleKey)), conflicts, orderPending: firstOrder };
}

/**
 * First contact with the account: its saved order wins; if it has none and this device has one
 * (chosen offline, or before the account could store it), that order is queued for the account.
 */
function firstSyncOrder(state: ModuleReplica, snapshot: ModuleSnapshot): PendingOrder[] {
  if (!("sidebar_order" in snapshot)) return state.orderPending;
  if (snapshot.sidebar_order) return [];
  const local = displayedOrder(state);
  return local.length ? [{ id: randomId(), keys: local, expected: 0 }] : [];
}

/** Queues a new sidebar order. Unsent earlier orders are replaced; one already sent stays first. */
export function enqueueOrder(state: ModuleReplica, keys: string[]): ModuleReplica {
  const order = normalizeOrder(keys);
  const last = state.orderPending[state.orderPending.length - 1];
  const expected = last ? last.expected + (last.request ? 1 : 0) : state.snapshot?.sidebar_order?.revision ?? 0;
  return { ...state, orderPending: [...state.orderPending.filter((item) => item.request), { id: randomId(), keys: order, expected }] };
}

export function freezeOrder(state: ModuleReplica): ModuleReplica {
  const first = state.orderPending[0];
  if (!state.snapshot || !first || first.request) return state;
  const request: ModuleMutation = {
    format: 2, device_id: state.deviceId, mutation_id: first.id, base_server_revision: state.snapshot.server_revision,
    changes: [], sidebar_order: { module_keys: first.keys, expected_revision: first.expected },
  };
  return { ...state, orderPending: [{ ...first, request }, ...state.orderPending.slice(1)] };
}

export function acknowledgeOrder(state: ModuleReplica, id: string, result: MutationResult): ModuleReplica {
  const first = state.orderPending[0];
  if (!first || first.id !== id || !isSnapshot(result, state.accountId)) throw new Error("Unmatched sidebar order response");
  const next = observeSnapshot(state, result);
  if (result.order_applied === true) return { ...next, orderPending: state.orderPending.slice(1) };
  if (result.order_conflict) return { ...next, orderPending: [] }; // the account's newer order wins
  throw new Error("Unacknowledged sidebar order");
}

export function enqueuePreference(state: ModuleReplica, id: string, visible: boolean): ModuleReplica {
  if (!canSyncChoice(id) || state.conflicts[id]) return state;
  const last = [...state.pending].reverse().find((item) => item.moduleKey === id);
  const expected = last ? last.expected + (last.request ? 1 : 0) : state.snapshot?.modules[id]?.revision ?? 0;
  const pending = state.pending.filter((item) => item.moduleKey !== id || item.request);
  return { ...state, pending: [...pending, { id: randomId(), moduleKey: id, visible, expected }] };
}

/** Restore the defaults for this surface using the regular revision-checked write queue. */
export function restoreReplicaDefaults(state: ModuleReplica): ModuleReplica {
  const ordered = displayedOrder(state).length ? enqueueOrder(state, []) : state;
  return enabledModules("app").reduce((next, module) => {
    const id = module.id;
    const visible = module.defaultSidebarVisible;
    const current = displayedPreferences(next).modules[id]?.sidebarVisible ?? visible;
    if (current === visible && !next.conflicts[id]) return next;

    const conflicts = { ...next.conflicts };
    delete conflicts[id];
    const resolved = { ...next, conflicts };
    const remote = next.snapshot?.modules[id];
    if (!next.pending.some((item) => item.moduleKey === id) && next.snapshot &&
      (remote ? serverVisible(remote) : visible) === visible) return resolved;
    return enqueuePreference(resolved, id, visible);
  }, ordered);
}

export function resolvePreference(state: ModuleReplica, id: string, keepLocal: boolean): ModuleReplica {
  const conflict = state.conflicts[id];
  if (!conflict || !state.snapshot) return state;
  const conflicts = { ...state.conflicts };
  delete conflicts[id];
  const next = { ...state, conflicts };
  return keepLocal ? enqueuePreference(next, id, conflict.visible) : next;
}

export function freezeMutation(state: ModuleReplica): ModuleReplica {
  const first = state.pending.find((item) => canSyncChoice(item.moduleKey));
  if (!state.snapshot || !first) return state;
  const remaining = state.pending.filter((item) => item !== first);
  if (first.request) return { ...state, pending: [first, ...remaining] };
  const request: ModuleMutation = {
    format: 2, device_id: state.deviceId, mutation_id: first.id, base_server_revision: state.snapshot.server_revision,
    changes: [{ module_key: first.moduleKey, sidebar_visible: first.visible, enabled: first.visible, expected_revision: first.expected }],
  };
  return { ...state, pending: [{ ...first, request }, ...remaining] };
}

export function acknowledgeMutation(state: ModuleReplica, id: string, result: MutationResult): ModuleReplica {
  const first = state.pending[0];
  if (!first || first.id !== id || !isSnapshot(result, state.accountId)) throw new Error("Unmatched module preference response");
  if (!Array.isArray(result.applied) || !Array.isArray(result.conflicts)) throw new Error("Invalid module preference response");
  const conflict = result.conflicts.find((item) => item?.module_key === first.moduleKey);
  if (conflict ? visibility(conflict.proposed_sidebar_visible, conflict.proposed_enabled) !== first.visible || !serverChoice(conflict.current) : !result.applied.includes(first.moduleKey)) {
    throw new Error("Unacknowledged module preference");
  }
  const next = observeSnapshot(state, result);
  const remaining = state.pending.slice(1);
  if (!conflict) return { ...next, pending: remaining };
  const preferred = [...state.pending].reverse().find((item) => item.moduleKey === first.moduleKey) ?? first;
  return {
    ...next,
    pending: remaining.filter((item) => item.moduleKey !== first.moduleKey),
    conflicts: { ...state.conflicts, [first.moduleKey]: { visible: preferred.visible, kind: "different" } },
  };
}
