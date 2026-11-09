// @vitest-environment jsdom
// The complete offline workflow through the real UI: import → dashboard → correct a
// category (remembered) → export CSV and Excel → delete all local data.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import initSqlJs from "sql.js";
import { fixtureBytes, migrate } from "./helpers";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { unzipStored } from "@billie/reporting";

const saved: Array<{ filename: string; bytes: Uint8Array }> = [];
vi.mock("../src/services/platform", () => ({
  isTauri: () => false,
  openDatabase: async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    return { driver: sqljsDriver(db), persistent: true };
  },
  saveFile: async (filename: string, bytes: Uint8Array) => {
    saved.push({ filename, bytes });
    return true;
  },
}));

const { default: App } = await import("../src/App");

function upload(input: HTMLInputElement, name: string, bytes: Uint8Array) {
  const file = new File([bytes as BlobPart], name, { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  fireEvent.change(input, { target: { files: [file] } });
}

const nav = (label: string) => fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: label }));

afterEach(cleanup);

it("imports, categorizes, exports, and deletes — entirely offline", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  render(<App />);
  await screen.findByText("No statements yet");

  nav("Import");
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => upload(input, "basic-amount.csv", fixtureBytes("basic-amount.csv")));
  await screen.findByText(/basic-amount\.csv: 9 transactions imported, closing balance \$3,448\.65\./);

  // Same file again is refused.
  await act(async () => upload(input, "basic-amount.csv", fixtureBytes("basic-amount.csv")));
  await screen.findByText(/already imported/);

  nav("Dashboard");
  await screen.findByText("Monthly cash flow");
  expect(screen.getByText("$5,000.00")).toBeTruthy(); // income: two payrolls
  expect(screen.getByText(/need a category/)).toBeTruthy();

  nav("Transactions");
  const select = await screen.findByLabelText("Category for AMAZON WEB SERVICES AWS.AMAZON.CO");
  await act(async () => fireEvent.change(select, { target: { value: "Business" } }));
  await screen.findByText(/"amazon services" will be Business from now on/);

  nav("Settings");
  expect(await screen.findByText("amazon services")).toBeTruthy();

  nav("Reports");
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Export CSV" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export Excel" })));
  await waitFor(() => expect(saved.length).toBe(2));
  const csv = new TextDecoder().decode(saved[0].bytes);
  expect(saved[0].filename).toMatch(/^billieweather-report-all-time-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(csv).toContain("2026-01-15,basic-amount.csv,Amazon Services,AMAZON WEB SERVICES AWS.AMAZON.CO,Business,-61.2,USD,true,false,true");
  expect(csv).toContain("'=HYPERLINK(evil)");
  expect(unzipStored(saved[1].bytes).has("xl/worksheets/sheet3.xml")).toBe(true);

  nav("Settings");
  const confirm = await screen.findByLabelText("Type DELETE to confirm");
  const deleteButton = screen.getByRole("button", { name: "Delete all local data" });
  expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(confirm, { target: { value: "DELETE" } });
  await act(async () => fireEvent.click(deleteButton));
  await screen.findByText("All local financial data was deleted from this device.");

  nav("Dashboard");
  await screen.findByText("No statements yet");
  expect(fetchSpy).not.toHaveBeenCalled();
});
