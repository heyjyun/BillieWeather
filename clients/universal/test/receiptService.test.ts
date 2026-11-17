// Receipt reading and saving without the UI: PDF receipts use their text layer, files that are not
// receipts are refused, a missing OCR engine is reported (never replaced by a cloud one), and a
// confirmed receipt becomes one manual entry through the ledger. Synthetic data only.
import { makePdf, newStore } from "./helpers";
import { registerOcrEngine } from "../src/services/ocrEngine";
import { checkDuplicates, entryFromReceipt, extractReceipt, initialValues, matchCandidates, ReceiptError, recognizeReceipt, webFields } from "../src/services/receipt";

const WORDS = { fromReceipt: "From receipt", number: "No. {number}", tax: "Tax {amount}", tip: "Tip {amount}" };

afterEach(() => registerOcrEngine(null));

it("reads a text PDF receipt from its text layer, on the device", async () => {
  const pdf = makePdf([["ZXQ HARDWARE", "Invoice # INV-20931", "Date 2026-11-02", [[50, "Hammer"], [400, "18.00"]], [[50, "Subtotal"], [400, "18.00"]], [[50, "Sales tax"], [400, "1.44"]], [[50, "Total due"], [400, "$19.44"]]]]);
  const recognized = await recognizeReceipt(pdf, "invoice.pdf");
  expect(recognized.engine).toBe("pdf-text");
  expect(recognized.source).toBe("pdf_text");
  const extraction = extractReceipt(recognized.lines, { currency: "USD", today: "2026-11-16" });
  expect(extraction.merchant.value).toBe("ZXQ HARDWARE");
  expect(extraction.date.value).toBe("2026-11-02");
  expect(extraction.total.value).toBe("19.44");
  expect(extraction.tax.value).toBe("1.44");
  expect(extraction.receiptNumber.value).toBe("INV-20931");
});

it("refuses files that are not receipts and reports a missing OCR engine", async () => {
  await expect(recognizeReceipt(new TextEncoder().encode("date,amount\n"), "x.csv")).rejects.toMatchObject({ code: "unsupported" });
  registerOcrEngine(null);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  await expect(recognizeReceipt(png, "r.png")).rejects.toBeInstanceOf(ReceiptError);
  await expect(recognizeReceipt(png, "r.png")).rejects.toMatchObject({ code: "ocr_unavailable" });
});

it("turns a confirmed receipt into one expense and never matches transfers", async () => {
  const { store } = await newStore();
  await store.ledger.setBookCurrency("USD");
  const checking = await store.ledger.createAccount({ name: "ZXQ Checking", type: "checking" });
  const card = await store.ledger.createAccount({ name: "ZXQ Card", type: "credit_card" });
  // A card payment of the same amount on the same day is not this purchase.
  await store.ledger.createEntry({ kind: "transfer", amountCents: 1944, occurredOn: "2026-11-02", accountId: checking.id, toAccountId: card.id });
  const values = { ...initialValues(extractReceipt("ZXQ HARDWARE\nDate 2026-11-02\nTOTAL DUE $19.44\nTIP 0.00", { currency: "USD", today: "2026-11-16" })) };
  expect(checkDuplicates(values, matchCandidates(await store.transactions(), await store.ledger.accounts(), "USD")).level).toBe("none");

  const input = entryFromReceipt({ ...values, receiptNumber: "R-1" }, { accountId: card.id, category: "Shopping", words: WORDS });
  expect(input).toMatchObject({ kind: "expense", amountCents: 1944, occurredOn: "2026-11-02", description: "ZXQ HARDWARE", merchant: "ZXQ HARDWARE", category: "Shopping", note: "From receipt · No. R-1 · Tip 0.00" });
  const [id] = await store.ledger.createEntry(input);
  const saved = await store.ledger.entry(id);
  expect(saved).toMatchObject({ kind: "expense", amountCents: -1944, description: "ZXQ HARDWARE", merchant: "ZXQ HARDWARE", origin: "manual" });
  // Now the receipt matches its own entry exactly.
  expect(checkDuplicates(values, matchCandidates(await store.transactions(), await store.ledger.accounts(), "USD")).level).toBe("exact");
  expect(webFields(values)).toMatchObject({ total: "19.44", tip: "0.00", tax: null, date: "2026-11-02", currency: "USD", direction: "purchase" });
});
