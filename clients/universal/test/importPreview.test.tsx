// @vitest-environment jsdom
// The import preview gate in the real component: ambiguous settings block the Import button
// until the person chooses, duplicates need a decision, edits win, and the labels follow the
// interface language without changing any value. Synthetic data only.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { allCategories, type ImportContext, type ImportDraft } from "@billie/finance-core";
import { ImportPreview } from "../src/components/ImportPreview";
import { I18nProvider, type Locale } from "../src/i18n";
import { newStore } from "./helpers";
import { importContext, importDraftFile } from "../src/services/universalImport";
import { registerOcrEngine } from "../src/services/ocrEngine";

afterEach(cleanup);
const enc = (text: string) => new TextEncoder().encode(text);

function Harness(props: { initial: ImportDraft; context: ImportContext; onConfirm: (draft: ImportDraft) => void }) {
  const [draft, setDraft] = useState(props.initial);
  return <ImportPreview draft={draft} context={props.context} categories={allCategories([])} busy={false} error={null} onChange={setDraft} onConfirm={(next) => props.onConfirm(next)} onCancel={() => undefined} />;
}

async function show(csv: string, currency: "GBP" | "USD", locale: Locale = "en") {
  const { store } = await newStore();
  const draft = await importDraftFile(store, enc(csv), "statement.csv", currency);
  const context = { ...(await importContext(store)), deviceCurrency: currency };
  const confirmed: ImportDraft[] = [];
  render(<I18nProvider initial={locale}><Harness initial={draft} context={context} onConfirm={(next) => confirmed.push(next)} /></I18nProvider>);
  return { confirmed };
}

it("blocks an ambiguous date order until the person chooses it, then imports the chosen reading", async () => {
  const { confirmed } = await show("Date,Description,Paid out,Paid in\n03/04/2026,TESCO,12.50,\n04/05/2026,SALARY,,1500.00\n", "GBP");
  const button = screen.getByRole("button", { name: /Import \d+ transactions/ }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByText(/Choose the highlighted settings before importing/)).toBeTruthy();
  const order = screen.getByLabelText("Date order") as HTMLSelectElement;
  expect(order.getAttribute("aria-invalid")).toBe("true");
  await act(async () => fireEvent.change(order, { target: { value: "dmy" } }));
  expect(screen.getByText("2026-04-03")).toBeTruthy();
  const ready = screen.getByRole("button", { name: "Import 2 transactions" }) as HTMLButtonElement;
  expect(ready.disabled).toBe(false);
  await act(async () => fireEvent.click(ready));
  expect(confirmed[0].rows.map((row) => [row.transactionDate, row.amountMinor])).toEqual([["2026-04-03", -1250], ["2026-05-04", 150000]]);
});

it("lets the person fix an unreadable amount; the edit is authoritative", async () => {
  const { confirmed } = await show("Date,Description,Amount\n2026-03-01,Coffee,-4.50\n2026-03-02,Mystery,n/a\n", "USD");
  const row = document.querySelector('tr[data-row="r3"]') as HTMLElement;
  expect(within(row).getAllByText("Cannot import").length).toBeGreaterThan(0);
  expect(within(row).getByText("Amount not recognized.")).toBeTruthy();
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Edit" })));
  await act(async () => fireEvent.change(within(row).getByLabelText("Amount"), { target: { value: "-7.25" } }));
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Save" })));
  expect(within(document.querySelector('tr[data-row="r3"]') as HTMLElement).getByText("Edited by you.")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Import 2 transactions" })));
  expect(confirmed[0].rows[1]).toMatchObject({ amountMinor: -725, status: "valid" });
});

it("shows the same values in Simplified and Traditional Chinese, translated labels only", async () => {
  const csv = "交易日期,摘要,金额\n2026-03-01,星巴克 上海,-30.00\n";
  const texts: string[] = [];
  for (const locale of ["zh-CN", "zh-TW", "en"] as const) {
    await show(csv, "USD", locale);
    const row = document.querySelector('tr[data-row="r2"]') as HTMLElement;
    texts.push([...row.querySelectorAll("td")].slice(1, 4).map((cell) => cell.textContent).join("|"));
    if (locale === "zh-CN") expect(screen.getByRole("button", { name: "导入 1 笔交易" })).toBeTruthy();
    if (locale === "zh-TW") expect(screen.getByRole("button", { name: "匯入 1 筆交易" })).toBeTruthy();
    cleanup();
  }
  expect(new Set(texts).size).toBe(1);
  expect(texts[0]).toBe("2026-03-01|星巴克 上海|-$30.00");
});

it("only on-device OCR engines can be registered (no hidden cloud OCR)", () => {
  expect(() => registerOcrEngine({ info: { id: "cloud", location: "cloud", languages: [] }, recognize: async () => ({ engine: { id: "cloud", version: "1" }, languages: [], pages: [], errors: [], unsupported: [] }) })).toThrow();
  registerOcrEngine(null);
});
