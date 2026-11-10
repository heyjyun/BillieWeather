# Universal Financial Data Import

Shared, dependency-free TypeScript used by every BillieWeather app (macOS, Windows, iOS,
Android via Tauri, and the browser preview). Pure functions only: no I/O, no network.

```
Upload -> Detect -> Extract -> Normalize -> Validate -> Preview -> Confirm -> Commit
detect.ts   xlsx.ts / ofx.ts / ocr.ts   normalize.ts   relations.ts   pipeline.ts   (storage adapter)
```

| File | Responsibility |
|---|---|
| `schema.ts` | BillieWeather Financial Data Schema v1 (`CanonicalTransaction`, issues, statuses) |
| `currency.ts` | ISO 4217 minor units; exact decimal ⇄ integer conversion; spreadsheet float-noise rule; scale-2 storage conversion |
| `amount.ts` | Amount text in bank formats; per-column decimal-separator detection (reports ambiguity, never guesses) |
| `dates.ts` | Date formats; per-column day/month order detection (proven by a value > 12, otherwise the person chooses) |
| `detect.ts` | File kind from magic bytes; encoding (BOM / UTF-8 / legacy CJK & Latin, unconfident → confirm); RFC 4180 parser with delimiter detection |
| `mapping.ts` | Multilingual header aliases (en, zh-Hans, zh-Hant, ja, ko, de, fr, es); header-row detection; preamble account details (last 4 digits only); templates with exact header fingerprints and format-change detection |
| `normalize.ts` | Table rows → canonical rows with issues; person's edits applied last and authoritative |
| `xlsx.ts` | Read-only `.xlsx` (ZIP + SpreadsheetML), zip-bomb and XXE defences, exact number text, date styles |
| `ofx.ts` | OFX 1.x SGML / 2.x XML / QFX, multi-account; full account numbers never leave the parser |
| `ocr.ts` | OCR result contract, adapter-output validation, deskew, layout reconstruction (x-anchored columns, per-cell confidence, row boxes). Engines live in the apps (Apple Vision, ML Kit, Tesseract WASM). |
| `relations.ts` | Account-scoped duplicates (bank id; date+amount+description with occurrence counting), transfer hints, running-balance reconciliation |
| `pipeline.ts` | `createDraft`, `reviseDraft`, `decisionFor`, `commitPlan` (the confirm gate), `statementHashes` |

## Safety rules (enforced in code and tests)

- Money is an integer in minor units; JS numbers only ever hold integers below 10^15.
- A setting that changes results (date order, decimal separator, currency, credit-card sign
  convention, unconfident encoding, a changed template) puts the draft in `needs` and
  `commitPlan` refuses until it is chosen.
- Rows: `valid` → included; `needs_review` → undecided until a person decides;
  `rejected` → never committed (reported with row number and reason). A bank-id duplicate is
  skipped by default but can be overridden.
- Rows in another currency are rejected and reported, never converted. No FX conversion exists.
- Storage keeps the historical fixed scale-2 `amount_cents`; amounts that cannot be represented
  exactly (3-decimal currencies) are refused at commit.
- The interface language is not an input to any function here.

## Platform adapters

- Storage: `clients/universal/src/services/store.ts` (`commitImport`, atomic via the
  `statements_commit_staged` trigger in migration `0004_universal_import.sql`).
- OCR: `clients/universal/src/services/ocrEngine.ts` picks the platform engine; `registerOcrEngine`
  accepts only `location: "device"` engines. OCR rows are valid only when the statement's balances
  prove them (`Reconciliation.balanceVerified`); otherwise they need review (`ocr_unverified`).
- Text PDFs keep the existing Rails-parity extractor (`pdf.ts`) and its review screen.
- The Rails website keeps its own importer (`app/services/finance/statement_importer.rb`); this
  pipeline is not used on the server yet.
