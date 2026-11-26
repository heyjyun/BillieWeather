// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import type { ModulePreferences } from "@billie/shared-types";
import {
  acknowledgeMutation, displayedPreferences, enqueuePreference, freezeMutation, loadReplica, observeSnapshot, resolvePreference, restoreReplicaDefaults, saveReplica,
  type ModuleSnapshot, type MutationResult, type ServerChoice,
} from "../src/services/moduleSync";

const A = "cc32ddab-f1c4-4598-bc48-1c280a110110";
const B = "acc0e7cb-f188-40a0-aaca-5dace6b1b7f1";
const empty: ModulePreferences = { format: 1, modules: {} };
const choice = (visible: boolean, revision: number): ServerChoice => ({
  sidebar_visible: visible, enabled: visible, revision, changed_at: "2000-01-01T00:00:00Z", updated_by_device_id: null,
});
// What a server released before 2026-11-26 answers: the same choice under the legacy name only.
const legacyChoice = (visible: boolean, revision: number): ServerChoice => ({
  enabled: visible, revision, changed_at: "2000-01-01T00:00:00Z", updated_by_device_id: null,
});
const snap = (modules: ModuleSnapshot["modules"] = {}, account_id = A): ModuleSnapshot => ({
  format: 2, account_id, server_revision: Object.values(modules).reduce((sum, c) => sum + c.revision, 0), defaults_version: 1, modules,
});

beforeEach(() => localStorage.clear());

describe("module preference replica", () => {
  it("preserves all first-sync cases and keeps both disagreeing choices until resolved", () => {
    const initial: ModulePreferences = { format: 1, modules: {
      reports: { sidebarVisible: true, changedAt: "2099-05-01" }, budgets: { sidebarVisible: true, changedAt: "" },
      accounts: { sidebarVisible: false, changedAt: "" }, goals: { sidebarVisible: true, changedAt: "" },
    } };
    const state = observeSnapshot(loadReplica(A, initial), snap({
      reports: choice(false, 2), accounts: choice(false, 1), recurring: choice(true, 4),
    }));
    expect(state.conflicts).toEqual({ reports: { visible: true, kind: "different" }, budgets: { visible: true, kind: "local_only" } });
    expect(displayedPreferences(state).modules).toMatchObject({ reports: { sidebarVisible: true }, accounts: { sidebarVisible: false }, recurring: { sidebarVisible: true } });
    expect(state.pending).toEqual([]);
    const chosen = resolvePreference(resolvePreference(state, "reports", true), "budgets", false);
    expect(chosen.pending).toMatchObject([{ moduleKey: "reports", visible: true, expected: 2 }]);
    expect(chosen.conflicts).toEqual({});
    expect(displayedPreferences(chosen).modules.budgets).toBeUndefined();
  });

  it("keeps offline intents and the exact retry body on restart, scoped by immutable account", () => {
    const original = observeSnapshot(loadReplica(A, empty), snap());
    const frozen = freezeMutation(enqueuePreference(original, "reports", true));
    expect(saveReplica(frozen)).toBe(true);
    const restored = loadReplica(A, empty);
    expect(restored.pending).toEqual(frozen.pending);
    // Both names, always equal, so servers from before 2026-11-26 understand the change too.
    expect(restored.pending[0].request?.changes).toEqual([{ module_key: "reports", sidebar_visible: true, enabled: true, expected_revision: 0 }]);
    expect(loadReplica(B, empty).pending).toHaveLength(0);
    expect(observeSnapshot(restored, snap({}, B))).toBe(restored);
    expect(displayedPreferences(restored).modules.reports?.sidebarVisible).toBe(true);
  });

  it("collapses conflicting edits of one module while keeping unrelated queued work", () => {
    let state = observeSnapshot(loadReplica(A, empty), snap());
    state = freezeMutation(enqueuePreference(state, "budgets", true));
    const first = state.pending[0];
    state = enqueuePreference(enqueuePreference(state, "reports", true), "budgets", false);
    const reply: MutationResult = {
      ...snap({ budgets: choice(true, 1) }), applied: [],
      conflicts: [{ module_key: "budgets", proposed_sidebar_visible: true, proposed_enabled: true, current: choice(true, 1) }],
    };
    state = acknowledgeMutation(state, first.id, reply);
    expect(state.conflicts.budgets).toEqual({ visible: false, kind: "different" });
    expect(state.pending.map((item) => item.moduleKey)).toEqual(["reports"]);
    expect(freezeMutation(state).pending[0].request?.changes[0].expected_revision).toBe(0);
  });

  it("ignores older replay snapshots and chains rapid edits without silently rebasing", () => {
    let state = observeSnapshot(loadReplica(A, empty), snap());
    state = freezeMutation(enqueuePreference(state, "budgets", true));
    const first = state.pending[0];
    state = enqueuePreference(state, "budgets", false);
    state = observeSnapshot(state, snap({ budgets: choice(true, 2) }));
    state = acknowledgeMutation(state, first.id, { ...snap({ budgets: choice(true, 1) }), applied: ["budgets"], conflicts: [] });
    expect(state.snapshot?.server_revision).toBe(2);
    expect(freezeMutation(state).pending[0].request?.changes[0].expected_revision).toBe(1);
  });

  it("retains an old cache and retries when an acknowledgement is malformed", () => {
    const state = freezeMutation(enqueuePreference(observeSnapshot(loadReplica(A, empty), snap()), "budgets", true));
    const id = state.pending[0].id;
    expect(() => acknowledgeMutation(state, id, { ...snap(), applied: [], conflicts: [] })).toThrow();
    expect(state.pending[0].request?.mutation_id).toBe(id);
    expect(() => acknowledgeMutation(state, id, { ...snap({}, B), applied: ["budgets"], conflicts: [] })).toThrow();
    const legacy: ModulePreferences = { format: 1, modules: { budgets: { sidebarVisible: true, changedAt: "" } } };
    localStorage.setItem("billie.modules.v2:" + A, '{"format":2,"accountId":"wrong"}');
    expect(displayedPreferences(loadReplica(A, legacy))).toEqual(legacy);
    expect(localStorage.getItem("billie.modules.v2:" + A)).toContain("wrong");
  });

  it("does not send a revision-zero write based on an offline startup with no server snapshot", () => {
    const local = enqueuePreference(loadReplica(A, empty), "budgets", true);
    expect(freezeMutation(local).pending[0].request).toBeUndefined();
    const state = observeSnapshot(local, snap({ budgets: choice(false, 14) }));
    expect(state.conflicts.budgets).toEqual({ visible: true, kind: "different" });
  });

  it("restores app defaults with current revisions without writing a website-only choice", () => {
    const state = observeSnapshot(loadReplica(A, empty), snap({
      reports: choice(true, 2), forecast: choice(true, 3), ai_assistant: choice(false, 4),
    }));
    const reset = restoreReplicaDefaults(state);
    expect(reset.pending).toMatchObject([
      { moduleKey: "ai_assistant", visible: true, expected: 4 },
      { moduleKey: "reports", visible: false, expected: 2 },
    ]);
    expect(displayedPreferences(reset).modules.forecast?.sidebarVisible).toBe(true);
  });

  it("understands servers and saved replicas from before the rename (`enabled`)", () => {
    // A server that only answers `enabled`.
    let state = observeSnapshot(loadReplica(A, empty), snap({ reports: legacyChoice(true, 1), budgets: legacyChoice(false, 2) }));
    expect(displayedPreferences(state).modules).toMatchObject({ reports: { sidebarVisible: true }, budgets: { sidebarVisible: false } });
    state = freezeMutation(enqueuePreference(state, "accounts", true));
    const id = state.pending[0].id;
    state = acknowledgeMutation(state, id, {
      ...snap({ reports: legacyChoice(true, 1), budgets: legacyChoice(false, 2), accounts: legacyChoice(false, 3) }), applied: [],
      conflicts: [{ module_key: "accounts", proposed_enabled: true, current: legacyChoice(false, 3) }],
    });
    expect(state.conflicts.accounts).toEqual({ visible: true, kind: "different" });

    // A replica saved by an older app, with a frozen request that used only `enabled`.
    const oldPending = { id: "0f7b8a42-4b8c-4e0e-9d2f-7c1c3f7c9a01", moduleKey: "budgets", enabled: true, expected: 2,
      request: { format: 2, device_id: B, mutation_id: "0f7b8a42-4b8c-4e0e-9d2f-7c1c3f7c9a01", base_server_revision: 3,
        changes: [{ module_key: "budgets", enabled: true, expected_revision: 2 }] } };
    localStorage.setItem("billie.modules.v2:" + A, JSON.stringify({
      format: 2, accountId: A, deviceId: B, snapshot: snap({ reports: legacyChoice(true, 1), budgets: legacyChoice(false, 2) }), pending: [oldPending],
      conflicts: { categories: { enabled: false, kind: "local_only" } },
    }));
    const restored = loadReplica(A, empty);
    expect(restored.deviceId).toBe(B);
    expect(restored.pending).toMatchObject([{ moduleKey: "budgets", visible: true, expected: 2 }]);
    expect(restored.pending[0].request?.changes).toEqual([{ module_key: "budgets", enabled: true, expected_revision: 2 }]); // resent byte for byte
    expect(restored.conflicts).toEqual({ categories: { visible: false, kind: "local_only" } });
    expect(displayedPreferences(restored).modules).toMatchObject({ budgets: { sidebarVisible: true }, categories: { sidebarVisible: false } });
  });

  it("refuses a server choice whose two names disagree", () => {
    const bad = { sidebar_visible: true, enabled: false, revision: 1, changed_at: null, updated_by_device_id: null };
    const state = loadReplica(A, empty);
    expect(observeSnapshot(state, snap({ reports: bad }))).toBe(state);
  });
});
