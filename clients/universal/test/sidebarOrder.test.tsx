// @vitest-environment jsdom
// Sidebar customization (2026-11-28): default entries, saved order, drag and the arrow buttons, add,
// hide, restore, persistence across restarts, and synchronization of the order with the account
// (services/moduleSync.ts, hooks/useModules.tsx). Hiding never makes a module unusable. Synthetic only.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isModuleEnabled, normalizePreferences, sidebarModules } from "@billie/shared-types";
import { ModulesProvider, useModules } from "../src/hooks/useModules";
import { I18nProvider } from "../src/i18n";
import { loadModulePreferences, preferencesKey } from "../src/services/modulePreferences";
import {
  acknowledgeOrder, displayedPreferences, enqueueOrder, enqueuePreference, freezeOrder, loadReplica, observeSnapshot, replicaKey, restoreReplicaDefaults, saveReplica,
  type ModuleMutation, type ModuleSnapshot, type ServerOrder,
} from "../src/services/moduleSync";
import { FeatureManager } from "../src/pages/FeatureLibrary";
import { SidebarCustomizationSection } from "../src/settings/SidebarCustomization";
import { installDropGuard } from "../src/services/dropGuard";

const A = "cc32ddab-f1c4-4598-bc48-1c280a110110";
const DEFAULT = ["overview", "ai_assistant"];
const order = (module_keys: string[], revision = 1): ServerOrder => ({ module_keys, revision, changed_at: "2026-11-28T10:00:00.000000Z", updated_by_device_id: null });
const snapshot = (sidebar_order?: ServerOrder | null, server_revision = sidebar_order?.revision ?? 0): ModuleSnapshot => ({
  format: 2, account_id: A, server_revision, defaults_version: 5, modules: {}, ...(sidebar_order === undefined ? {} : { sidebar_order }),
});
const ids = (preferences: ReturnType<typeof displayedPreferences>) => sidebarModules(preferences, "app").map((module) => module.id);

function Nav() {
  const { sidebarList } = useModules();
  return <nav aria-label="Sidebar"><ul>{sidebarList.map((module) => <li key={module.id}>{module.id}</li>)}<li>settings</li></ul></nav>;
}
const entries = () => within(screen.getByRole("navigation", { name: "Sidebar" })).getAllByRole("listitem").map((item) => item.textContent);
const mount = (props: { accountId?: string; getToken?: () => string | null } = {}) => render(
  <I18nProvider initial="en"><ModulesProvider ownerKey="id:zxq" {...props}><Nav /><FeatureManager embedded /><SidebarCustomizationSection shell={null} /></ModulesProvider></I18nProvider>,
);

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows the two default entries in order, then Settings, which cannot be moved or hidden", () => {
  mount();
  expect(entries()).toEqual([...DEFAULT, "settings"]);
  const section = within(screen.getByRole("region", { name: "Sidebar customization" }));
  const settings = document.querySelector<HTMLElement>('[data-sidebar-order] [data-module-key="settings"]')!;
  expect(settings.getAttribute("draggable")).toBeNull();
  expect(within(settings).queryAllByRole("button")).toHaveLength(0);
  expect(section.getByRole("button", { name: "Move Financial Overview up" })).toHaveProperty("disabled", true);
  expect(section.getByRole("button", { name: "Move AI Insight down" })).toHaveProperty("disabled", true);
});

it("moves entries with the arrow buttons and keeps the order across a restart", () => {
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "Move AI Insight up" }));
  expect(entries()).toEqual(["ai_assistant", "overview", "settings"]);
  expect(loadModulePreferences("id:zxq").order).toEqual(["ai_assistant", "overview"]);
  view.unmount();
  mount();
  expect(entries()).toEqual(["ai_assistant", "overview", "settings"]);
});

it("reorders by drag and drop and shows it in the sidebar at once, with the app's file-drop guard installed", () => {
  // The guard (installed by the app at startup) once cancelled every drop, in-app ones included.
  const uninstall = installDropGuard(document);
  mount();
  const item = (id: string) => document.querySelector<HTMLElement>(`[data-sidebar-order] [data-module-key="${id}"]`)!;
  const data = { effectAllowed: "", setData: () => undefined };
  fireEvent.dragStart(item("overview"), { dataTransfer: data });
  // jsdom's synthetic drag events carry no pointer position, which counts as the lower half: after the target.
  fireEvent.dragOver(item("ai_assistant"), { dataTransfer: data });
  fireEvent.drop(item("ai_assistant"), { dataTransfer: data });
  expect(entries()).toEqual(["ai_assistant", "overview", "settings"]);
  expect(loadModulePreferences("id:zxq").order).toEqual(["ai_assistant", "overview"]);
  uninstall();
});

it("adds any available module, hides one without making it unusable, and restores the defaults", () => {
  mount();
  fireEvent.click(screen.getByRole("switch", { name: "Show Budgets in the sidebar" }));
  expect(entries()).toEqual([...DEFAULT, "budgets", "settings"]);
  fireEvent.click(screen.getByRole("button", { name: "Move Budgets up" }));
  fireEvent.click(screen.getByRole("switch", { name: "Show AI Insight in the sidebar" }));
  expect(entries()).toEqual(["overview", "budgets", "settings"]);
  expect(isModuleEnabled("ai_assistant", "app")).toBe(true);
  expect(screen.getByRole("switch", { name: "Show AI Insight in the sidebar" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Restore default sidebar" }));
  expect(entries()).toEqual([...DEFAULT, "settings"]);
  expect(loadModulePreferences("id:zxq").order).toBeUndefined();
});

it("keeps choices saved before ordering existed, and puts a module added to the catalog later after the saved order", () => {
  localStorage.setItem(preferencesKey("id:zxq"), JSON.stringify({ format: 1, modules: { reports: { enabled: true, changedAt: "2026-11-24T00:00:00Z" }, overview: { sidebarVisible: false, changedAt: "" } } }));
  mount();
  expect(entries()).toEqual(["ai_assistant", "reports", "settings"]);
  // A saved order that does not know a module (e.g. one added in a later catalog) leaves it after the named ones.
  const saved = normalizePreferences({ format: 1, modules: { budgets: { sidebarVisible: true, changedAt: "" } }, order: ["accounts", "transactions", "ai_assistant", "overview", "categories"] });
  expect(sidebarModules(saved, "app").map((module) => module.id)).toEqual(["ai_assistant", "overview", "budgets"]);
});

it("preserves an offline v3 sidebar and replays its queued edit after a restart", () => {
  const legacy = loadReplica(A, { format: 1, modules: {} });
  const edited = enqueueOrder(legacy, ["categories", "ai_assistant"]);
  localStorage.setItem(replicaKey(A), JSON.stringify(edited));
  const upgraded = loadReplica(A, { format: 1, modules: {} });
  expect(ids(displayedPreferences(upgraded))).toEqual(["ai_assistant", "overview"]);
  saveReplica(upgraded);
  expect(ids(displayedPreferences(loadReplica(A, { format: 1, modules: {} })))).toEqual(ids(displayedPreferences(upgraded)));
});

it("replica: a new order is queued, frozen into one request, and acknowledged", () => {
  let state = observeSnapshot(loadReplica(A, { format: 1, modules: {} }), snapshot(null));
  state = enqueueOrder(state, ["accounts", "ai_assistant"]);
  expect(ids(displayedPreferences(state))).toEqual(["ai_assistant", "overview"]);
  state = freezeOrder(state);
  const request = state.orderPending[0].request!;
  expect(request).toMatchObject({ format: 2, changes: [], sidebar_order: { module_keys: ["accounts", "ai_assistant"], expected_revision: 0 } });
  // Saved and loaded again (a restart), the exact request is kept for a retry.
  saveReplica(state);
  expect(loadReplica(A, { format: 1, modules: {} }).orderPending[0].request).toEqual(request);
  state = acknowledgeOrder(state, request.mutation_id, { ...snapshot(order(["accounts", "ai_assistant"])), applied: [], conflicts: [], order_applied: true, order_conflict: null });
  expect(state.orderPending).toEqual([]);
  expect(ids(displayedPreferences(state))).toEqual(["ai_assistant", "overview"]);
});

it("replica: on a conflict the account's newer order wins and this device's attempt is dropped", () => {
  let state = observeSnapshot(loadReplica(A, { format: 1, modules: {} }), snapshot(order(["categories"], 1)));
  state = freezeOrder(enqueueOrder(state, ["overview"]));
  const id = state.orderPending[0].id;
  state = acknowledgeOrder(state, id, { ...snapshot(order(["ai_assistant"], 2)), applied: [], conflicts: [], order_applied: false,
    order_conflict: { proposed_module_keys: ["overview"], current: order(["ai_assistant"], 2) } });
  expect(state.orderPending).toEqual([]);
  expect(ids(displayedPreferences(state))[0]).toBe("ai_assistant");
});

it("replica: first sync takes the account's order, or uploads this device's when the account has none", () => {
  const local = { format: 1 as const, modules: {}, order: ["categories", "ai_assistant"] };
  const kept = observeSnapshot(loadReplica(A, local), snapshot(order(["ai_assistant"])));
  expect(kept.orderPending).toEqual([]);
  expect(ids(displayedPreferences(kept))[0]).toBe("ai_assistant");
  const uploaded = observeSnapshot(loadReplica(A, local), snapshot(null));
  expect(uploaded.orderPending.map((item) => [item.keys, item.expected])).toEqual([[["categories", "ai_assistant"], 0]]);
});

it("replica: a server without sidebar order keeps the order on this device and never sends it", () => {
  let state = observeSnapshot(loadReplica(A, { format: 1, modules: {} }), snapshot(undefined));
  state = enqueueOrder(state, ["ai_assistant"]);
  expect(ids(displayedPreferences(state))[0]).toBe("ai_assistant");
  // Replicas saved before order existed (no orderPending) still load.
  const legacy = { format: 2, accountId: A, deviceId: "acc0e7cb-f188-40a0-aaca-5dace6b1b7f1", snapshot: null, initial: { format: 1, modules: {} }, pending: [], conflicts: {} };
  localStorage.setItem(replicaKey(A), JSON.stringify(legacy));
  expect(loadReplica(A, { format: 1, modules: {} }).orderPending).toEqual([]);
});

it("replica: a server upgrade uploads the saved local order when the account has none", () => {
  const local = { format: 1 as const, modules: {}, order: ["ai_assistant", "forecast", "overview"] };
  const state = observeSnapshot(loadReplica(A, local), snapshot(undefined));
  const upgraded = observeSnapshot(state, snapshot(null));
  expect(ids(displayedPreferences(upgraded)).slice(0, 2)).toEqual(["ai_assistant", "overview"]);
  expect(freezeOrder(upgraded).orderPending[0].request?.sidebar_order).toEqual({ module_keys: ["ai_assistant", "overview"], expected_revision: 0 });

  const alreadySaved = observeSnapshot(state, snapshot(order(["overview"])));
  expect(alreadySaved.orderPending).toEqual([]);
  expect(ids(displayedPreferences(alreadySaved))[0]).toBe("overview");
});

it("restores defaults on an upgraded device with a customized v3 account snapshot", () => {
  const state = observeSnapshot(loadReplica(A, { format: 1, modules: {} }), {
    ...snapshot(order(["categories", "transactions"])), defaults_version: 3,
    modules: { transactions: { enabled: true, changed_at: null, revision: 1, updated_by_device_id: null } },
  });
  expect(ids(displayedPreferences(state))).toEqual(["transactions", "overview", "ai_assistant"]);
  const reset = restoreReplicaDefaults(state);
  expect(ids(displayedPreferences(reset))).toEqual(DEFAULT);
  expect(reset.pending.map((item) => item.moduleKey)).toEqual(["transactions"]);
});

it("keeps the revision of a proven inherited server row without caching it as a choice", () => {
  const state = observeSnapshot(loadReplica(A, { format: 1, modules: {} }), {
    ...snapshot(), modules: {
      categories: { enabled: false, revision: 1, changed_at: null, updated_by_device_id: null, inherits_default: true },
    },
  });
  expect(displayedPreferences(state).modules.categories).toBeUndefined();
  expect(ids(displayedPreferences(state))).toEqual(DEFAULT);
  expect(enqueuePreference(state, "categories", true).pending[0].expected).toBe(1);
});

it("restores offline before the first GET, survives a restart and replays subsequent edits", () => {
  const initial = normalizePreferences({ format: 1, modules: { categories: { enabled: true } }, order: ["categories"] });
  const reset = restoreReplicaDefaults(loadReplica(A, initial));
  expect(ids(displayedPreferences(reset))).toEqual(DEFAULT);
  saveReplica(enqueuePreference(reset, "budgets", true));
  const restarted = loadReplica(A, initial);
  expect(ids(displayedPreferences(restarted))).toEqual([...DEFAULT, "budgets"]);
  const remote = { ...snapshot(order(["transactions"], 3)), modules: {
    transactions: { enabled: true, revision: 2, changed_at: null, updated_by_device_id: null },
  } };
  const connected = observeSnapshot(restarted, remote);
  expect(ids(displayedPreferences(connected))).toEqual([...DEFAULT, "budgets"]);
  expect(connected.orderPending).toMatchObject([{ keys: [], expected: 3 }]);
  expect(connected.pending.map(({ moduleKey, visible, expected }) => [moduleKey, visible, expected])).toEqual([
    ["transactions", false, 2], ["budgets", true, 0],
  ]);
});

it("replica: restore defaults also queues the catalog order", () => {
  const state = restoreReplicaDefaults(observeSnapshot(loadReplica(A, { format: 1, modules: {} }), snapshot(order(["accounts"]))));
  expect(state.orderPending.map((item) => item.keys)).toEqual([[]]);
  expect(ids(displayedPreferences(state))).toEqual(DEFAULT);
});

it("replica: restoring app defaults leaves a website-only order alone", () => {
  const state = observeSnapshot(loadReplica(A, { format: 1, modules: {} }), snapshot(order(["forecast"])));
  expect(restoreReplicaDefaults(state).orderPending).toEqual([]);
  expect(ids(displayedPreferences(state))).toEqual(DEFAULT);
});

it("synchronizes a drag with the account and shows the account's order on another device", async () => {
  const requests: ModuleMutation[] = [];
  let server: ServerOrder | null = null;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "PUT") {
      const body = JSON.parse(init.body as string) as ModuleMutation;
      requests.push(body);
      server = order(body.sidebar_order!.module_keys, (server?.revision ?? 0) + 1);
      return Response.json({ ...snapshot(server), applied: [], conflicts: [], order_applied: true, order_conflict: null });
    }
    return Response.json(snapshot(server));
  }));
  const token = () => "session-a";
  const view = mount({ accountId: A, getToken: token });
  await waitFor(() => expect(entries()).toEqual([...DEFAULT, "settings"]));
  fireEvent.click(screen.getByRole("button", { name: "Move AI Insight up" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0].sidebar_order).toEqual({ module_keys: ["ai_assistant", "overview"], expected_revision: 0 });
  expect(requests[0].changes).toEqual([]);
  view.unmount();
  // Another device: nothing stored locally, the account's order arrives with the first sync.
  localStorage.clear();
  await act(async () => { mount({ accountId: A, getToken: token }); });
  await waitFor(() => expect(entries()).toEqual(["ai_assistant", "overview", "settings"]));
});
