// @vitest-environment jsdom
// S2 (four-agent audit): website rows skipped as already imported here are announced, never "up to date".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { I18nProvider, MESSAGES } from "../src/i18n";
import type { WebSyncResult } from "../src/services/store";

const state: { sync: { status: string; result?: WebSyncResult } } = { sync: { status: "idle" } };
vi.mock("../src/hooks/useFinance", () => ({ useFinance: () => state }));
const { SyncStatus } = await import("../src/components/SyncStatus");

const result = (overrides: Partial<WebSyncResult>): WebSyncResult => ({
  statementsAdded: 0, statementsRemoved: 0, transactionsAdded: 0, transactionsUpdated: 0, transactionsRemoved: 0, skippedDuplicates: 0, duplicateTransactionsSkipped: 0, ...overrides,
});
const show = (r: WebSyncResult) => {
  state.sync = { status: "updated", result: r };
  render(<I18nProvider><SyncStatus /></I18nProvider>);
  return screen.getByRole("status").textContent ?? "";
};

afterEach(cleanup);

it("says up to date only when nothing changed and nothing was left out", () => {
  expect(show(result({}))).toBe(MESSAGES.en.sync.upToDate);
});

it("says how many website rows were not added again, instead of 'up to date'", () => {
  const text = show(result({ duplicateTransactionsSkipped: 2 }));
  expect(text).not.toBe(MESSAGES.en.sync.upToDate);
  expect(text).toContain("2 transaction(s)");
});

it("adds the skipped count to a download that also changed something", () => {
  const text = show(result({ transactionsAdded: 1, duplicateTransactionsSkipped: 3 }));
  expect(text).toContain("1 new");
  expect(text).toContain("3 transaction(s)");
});

it("every app language has the message", () => {
  for (const [locale, copy] of Object.entries(MESSAGES)) expect(copy.sync.skippedDuplicates, locale).toContain("{count}");
});
