// @vitest-environment jsdom
// "Categorize with AI" says so when something unexpected fails on the device (reading the book,
// or writing the batch), instead of an unhandled rejection and a silent panel.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AiCategorizePanel } from "../src/components/AiCategorizePanel";
import { I18nProvider, MESSAGES } from "../src/i18n";

const finance = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/hooks/useFinance", () => ({ useFinance: () => finance.current }));
vi.mock("../src/hooks/useAccount", () => ({ useAccount: () => ({ getToken: () => "tok", expire: vi.fn() }) }));
vi.mock("../src/services/aiCategorize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/aiCategorize")>()),
  requestAiCategories: vi.fn(async () => [{ key: "k1", category: "Shopping" }]),
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const group = { key: "k1", text: "SYNTHETIC SHOP", direction: "out" as const, ids: [1, 2] };
const failed = MESSAGES.en.categoryPage.aiErrorFailed;

function mount(store: Record<string, unknown>) {
  const say = vi.fn();
  finance.current = { customCategories: [], refresh: vi.fn(async () => undefined), store };
  render(<I18nProvider initial="en"><AiCategorizePanel uncategorized={2} say={say} /></I18nProvider>);
  return say;
}

it("reports a book that cannot be read, and sends nothing", async () => {
  const say = mount({ aiCandidates: async () => { throw new Error("database is locked"); } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Categorize with AI" })); });
  expect(say).toHaveBeenLastCalledWith(failed, true);
  const { requestAiCategories } = await import("../src/services/aiCategorize");
  expect(requestAiCategories).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Categorize with AI" })).toBeTruthy(); // back to the start
});

it("reports a batch the device could not save", async () => {
  const say = mount({ aiCandidates: async () => [group], applyAiCategoriesBatch: async () => { throw new Error("database is locked"); } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Categorize with AI" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send and categorize" })); });
  expect(say).toHaveBeenLastCalledWith(failed, true);
  expect(screen.getByRole("button", { name: "Categorize with AI" })).toBeTruthy();
});
