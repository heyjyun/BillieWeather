// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import type { ModulePreferences } from "@billie/shared-types";
import {
  acknowledgeMutation, displayedPreferences, enqueuePreference, freezeMutation, loadReplica, observeSnapshot, resolvePreference, saveReplica,
  type ModuleSnapshot, type MutationResult, type ServerChoice,
} from "../src/services/moduleSync";

const A = "cc32ddab-f1c4-4598-bc48-1c280a110110";
const B = "acc0e7cb-f188-40a0-aaca-5dace6b1b7f1";
const empty: ModulePreferences = { format: 1, modules: {} };
const choice = (enabled: boolean, revision: number): ServerChoice => ({
  enabled, revision, changed_at: "2000-01-01T00:00:00Z", updated_by_device_id: null,
});
const snap = (modules: ModuleSnapshot["modules"] = {}, account_id = A): ModuleSnapshot => ({
  format: 2, account_id, server_revision: Object.values(modules).reduce((sum, c) => sum + c.revision, 0), defaults_version: 1, modules,
});

beforeEach(() => localStorage.clear());

describe("module preference replica", () => {
  it("preserves all first-sync cases and keeps both disagreeing choices until resolved", () => {
    const initial: ModulePreferences = { format: 1, modules: {
      reports: { enabled: true, changedAt: "2099-05-01" }, budgets: { enabled: true, changedAt: "" },
      accounts: { enabled: false, changedAt: "" }, goals: { enabled: true, changedAt: "" },
    } };
    const state = observeSnapshot(loadReplica(A, initial), snap({
      reports: choice(false, 2), accounts: choice(false, 1), recurring: choice(true, 4),
    }));
    expect(state.conflicts).toEqual({ reports: { enabled: true, kind: "different" }, budgets: { enabled: true, kind: "local_only" } });
    expect(displayedPreferences(state).modules).toMatchObject({ reports: { enabled: true }, accounts: { enabled: false }, recurring: { enabled: true } });
    expect(state.pending).toEqual([]);
    const chosen = resolvePreference(resolvePreference(state, "reports", true), "budgets", false);
    expect(chosen.pending).toMatchObject([{ moduleKey: "reports", enabled: true, expected: 2 }]);
    expect(chosen.conflicts).toEqual({});
    expect(displayedPreferences(chosen).modules.budgets).toBeUndefined();
  });

  it("keeps offline intents and the exact retry body on restart, scoped by immutable account", () => {
    const original = observeSnapshot(loadReplica(A, empty), snap());
    const frozen = freezeMutation(enqueuePreference(original, "reports", true));
    expect(saveReplica(frozen)).toBe(true);
    const restored = loadReplica(A, empty);
    expect(restored.pending).toEqual(frozen.pending);
    expect(restored.pending[0].request?.changes).toEqual([{ module_key: "reports", enabled: true, expected_revision: 0 }]);
    expect(loadReplica(B, empty).pending).toHaveLength(0);
    expect(observeSnapshot(restored, snap({}, B))).toBe(restored);
    expect(displayedPreferences(restored).modules.reports?.enabled).toBe(true);
  });

  it("collapses conflicting edits of one module while keeping unrelated queued work", () => {
    let state = observeSnapshot(loadReplica(A, empty), snap());
    state = freezeMutation(enqueuePreference(state, "budgets", true));
    const first = state.pending[0];
    state = enqueuePreference(enqueuePreference(state, "reports", true), "budgets", false);
    const reply: MutationResult = {
      ...snap({ budgets: choice(true, 1) }), applied: [],
      conflicts: [{ module_key: "budgets", proposed_enabled: true, current: choice(true, 1) }],
    };
    state = acknowledgeMutation(state, first.id, reply);
    expect(state.conflicts.budgets).toEqual({ enabled: false, kind: "different" });
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
    const legacy: ModulePreferences = { format: 1, modules: { budgets: { enabled: true, changedAt: "" } } };
    localStorage.setItem("billie.modules.v2:" + A, '{"format":2,"accountId":"wrong"}');
    expect(displayedPreferences(loadReplica(A, legacy))).toEqual(legacy);
    expect(localStorage.getItem("billie.modules.v2:" + A)).toContain("wrong");
  });

  it("does not send a revision-zero write based on an offline startup with no server snapshot", () => {
    const local = enqueuePreference(loadReplica(A, empty), "budgets", true);
    expect(freezeMutation(local).pending[0].request).toBeUndefined();
    const state = observeSnapshot(local, snap({ budgets: choice(false, 14) }));
    expect(state.conflicts.budgets).toEqual({ enabled: true, kind: "different" });
  });
});
