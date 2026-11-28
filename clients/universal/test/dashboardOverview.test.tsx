// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Transaction } from "@billie/shared-types";
import { Dashboard } from "../src/pages/Dashboard";
import { I18nProvider } from "../src/i18n";
import { CategoryTree } from "@billie/finance-core";

const finance = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/hooks/useFinance", () => ({ useFinance: () => finance.current, useOptionalCategoryTree: () => null }));
vi.mock("../src/hooks/useAccount", () => ({ useAccount: () => ({ account: null }) }));
afterEach(cleanup);

function txn(id: number, description: string, amountCents: number, kind: Transaction["kind"], accountId: number, bookedOn: string): Transaction {
  return { id, statementId: 1, description, amountCents, kind, accountId, bookedOn, category: kind === "income" ? "Income" : "Shopping",
    excluded: false, taxReview: false };
}
const data = [
  txn(1, "Synthetic salary", 100_000, "income", 1, "2026-10-01"),
  txn(2, "Synthetic purchase", -8_000, "expense", 2, "2026-10-05"),
  txn(3, "Synthetic refund", 3_000, "refund", 2, "2026-10-06"),
  txn(4, "Synthetic card payment", -5_000, "card_payment", 1, "2026-10-07"),
  txn(5, "Previous month", 80_000, "income", 1, "2026-09-12"),
];

it("filters accounts and custom dates, with interactive month figures calculated by economic kind", async () => {
  const switchDatabase = vi.fn(async () => undefined);
  finance.current = {
    store: { ledger: { recurringRules: async () => [] } }, categoryTree: new CategoryTree([]), transactions: data, statements: [], currency: "USD", ownerKey: null, accounts: [{ id: 1, name: "Checking" }, { id: 2, name: "Card" }],
    activeDatabaseId: "one", databaseIds: ["one", "two"], databaseName: "Home",
    openStore: vi.fn(async () => ({ databaseName: async () => "Work" })), switchDatabase,
  };
  const view = render(<I18nProvider><Dashboard go={vi.fn()} /></I18nProvider>);
  expect(await screen.findByRole("option", { name: "Work" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "2" } });
  expect(screen.queryByLabelText("Start date")).toBeNull();
  fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-31" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
  await waitFor(() => expect(view.container.querySelector("#dashboard-expenses strong")?.textContent).toBe("$50.00"));
  expect(view.container.querySelector("#dashboard-income strong")?.textContent).toBe("$0.00");
  expect(screen.queryByText("Synthetic salary")).toBeNull();
  expect(screen.getByText("Synthetic refund")).toBeTruthy();
  const trends = within(screen.getByRole("region", { name: "Income and expense trends" }));
  fireEvent.change(trends.getByLabelText("Group by"), {target: {value: "monthly"}});
  fireEvent.focus(trends.getByRole("slider"));
  expect(trends.getByText("$50.00")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-01" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
  expect(screen.getByRole("alert").textContent).toContain("valid");
  expect(view.container.querySelector("#dashboard-expenses strong")?.textContent).toBe("$50.00");

  fireEvent.change(screen.getByLabelText("Ledger"), { target: { value: "two" } });
  await waitFor(() => expect(switchDatabase).toHaveBeenCalledWith("two"));
});
