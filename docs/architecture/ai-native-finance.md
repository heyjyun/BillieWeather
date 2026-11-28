# AI-first finance with manual control

BillieWeather uses four shared capabilities. Capture proposes structured fields from text, statements and local OCR. Organize matches accounts and classifies ledger entries. Insight explains financial history. Next Step recommends a reviewable action from the current book. The existing modules own their financial writes. A recommendation is never permission to change a record.

## Implementation map

| Area | Existing implementation | Gap found in the audit |
| --- | --- | --- |
| Accounts | Rails Finance::BankAccount, Finance::Ledger and the SQLite LedgerStore implement the shared financial-schema.json taxonomy | Multi-account review, missing versus zero balances and accessible liability input |
| Natural language | billie-commands, nl-action-engine, SmartCommand::Executor and the client handlers provide scoped commands, confirmation, audit and bounded undo | Add a structured account proposal flow for more than one account |
| Capture | StatementAccountIdentity, StatementImporter, ImportPlan and PdfStatementExtractor on Web. Universal import pipeline, duplicate detector, receipt OCR adapters and atomic SqlDriver transactions on device | Reuse extraction for screenshots and match reviewed accounts to later imports |
| Organization | MerchantRule, category tree, user-locked fields, transaction links, duplicate review and signed ledger kinds | Evidence for missing accounts and a path from recommendations to these tools |
| Insight | OverviewData, CashFlowForecast, InsightGenerator, InsightChat and local dashboard analytics | A shared priority and feedback policy |
| Persistence | Authenticated PostgreSQL records on Web, owner-bound SQLite books on device. Financial sync copies supported Web data to the device. Local databases report metadata separately | Scope feedback to its evidence and synchronize portable preferences without sending local records |
| Controls | Settings, feature availability, regional preferences, manual workflow and explicit AI categorization consent | In-app proactive suggestion controls |
| Connectivity | No authorized institution adapter in this checkout | A provider contract and a future capability label |

Supported currencies and book boundaries continue to come from the ledger. A person reviews every proposed name, type, currency and amount. A missing balance stays pending. Financial totals must distinguish partial holdings. Deterministic domain code handles currency precision, liabilities and transfers. Document text is untrusted evidence, never an action or a command. Raw text, screenshots, secrets and identifiers beyond the last four digits do not belong in recommendation state or an external model request.


## From capture to a saved account

The empty Accounts page opens the editor. Once the book has accounts, the same controls fold into Add account. People can type a description, upload a screenshot, open statement review or use the manual form. The institution connection entry describes future availability. Existing sidebar ordering, category trees and the dedicated Fixed Assets module retain their own settings.

Both clients load `public/account-capture.mjs` and `public/account-assistant.mjs`. Extraction runs locally against supported terminology. Field annotations distinguish evidence from the description or image, suggestions, edits in review and unconfirmed values. The confirmed batch audit retains those origin codes without storing the raw description or image. A proposal carries the extracted institution, type, currency, last four digits, amount and reference date. Selected rows require a name, type and book currency. An amount requires a date. The suggested name can reuse a naming format demonstrated by two saved accounts. A region-specific shortlist supports free text. Missing evidence is editable, and unselected rows are excluded from the write. Dollar and yen symbols alone do not establish an ISO currency. The book currency appears as an editable suggestion in the preview.

Screenshot amounts require a current-balance label. Available credit, pending amounts, statement amounts and credit limits do not establish current debt. Multiple distinct account headers or identifiers require a more specific image. Low-confidence OCR lines are omitted. Universal uses the receipt engine on the device, including the bundled WebAssembly fallback where supported. Web explicitly discloses upload to its own server and uses the existing optional local OCR executable. These paths never call an external vision provider.

The shared command registry can open Accounts. Reviewed batch creation has a narrower structured boundary with a maximum of twenty rows. Rails uses `Finance::AccountCapture`, an owner lock, a command execution receipt, account validations and an audit event for each row. SQLite writes the batch, UUIDs, replay receipt and operation log in one transaction. Device editing history supports undo. Web's last batch can be undone for one day if the saved records still match their fingerprints and are unused. A conflicting correction prevents the entire undo. An unchanged replay returns the original result. Unrelated users cannot replay a receipt against someone else's accounts.

## Statements, balances and relationships

The account-driven Web import runs the existing importer in a rollback transaction for preview. It shows the proposed or matched account, transaction count and up to ten example rows. Confirmation reruns the pipeline under the owner's lock and verifies a short-lived digest covering the entire result. A source file, mapping or classification change requires another review. Original filename, content hash and statement links provide provenance. A PDF draft holds only normalized account metadata until its transactions are committed. The database creates its account and consumes the draft in the same transaction. Universal retains its existing staged import and deduplication workflow.

Web adds bounded single-visible-sheet XLSX decoding to the existing CSV and text-PDF importer. The executable in `lib/finance/statement-workbook.mjs` is generated from `packages/finance-core/src/universal/statement-workbook.mts` with the repository esbuild. It needs Node on the Rails host. Universal retains its existing workbook, image, scanned PDF and CSV paths.

PostgreSQL adds `balance_pending` and `balance_snapshot` to accounts, an assistant state object to each profile and normalized identity metadata to statement drafts. Earlier accounts keep their original opening-balance semantics. SQLite migration 12 adds the dated snapshot flag and extends stored account undo images and history triggers. Database upgrades use the existing migration and backup mechanisms.

A confirmed dated capture is a closing balance for that day. The ledger only adds movements after that date. A date before the snapshot has no verified historical balance. Updating that same date corrects the snapshot directly. Later reconciliation creates the difference as an adjustment. An explicit zero is known. Unknown balances are omitted from known holdings and identified in the account list. An identified cash statement can supply dated evidence for review. A credit-card statement does not establish today's outstanding debt.

Web's reconciliation screen offers unique opposite-sign pairs from different accounts in the same currency, up to three days apart, with a transfer or payment clue. It examines up to 250 recent imported entries and respects locked fields, existing links and rejected decisions. The action checks a fresh revision and uses the ledger to classify both legs. Universal opens its existing Organize review and applies only approved proposals. Confirmed transfers affect account balances and are excluded from income and expense totals.

## How Next Step decides

`public/next-steps.mjs` ranks findings from `Finance::NextStepFacts` on Web and a projection of the current SQLite book on Universal. Both hosts resolve a fixed set of destinations. The policy receives counts, dates, financial evidence and supported actions. It runs without an external model.

| Condition | Evidence and destination |
| --- | --- |
| Empty book, empty history or stale activity | Open account capture or statement review. Staleness uses the last recorded activity and a 45-day window. |
| Classification or duplication work | Current count and a filtered transaction view or duplicate review. |
| Possible account relationship | A reviewable pair in reconciliation or Organize. |
| Missing or inconsistent balance | Account name, dated statement evidence when available, and an editable reconciliation form. |
| Possible missing account | Outgoing transfer or card-payment evidence on at least two dates naming the same institution. Check existing institution and account names before showing a proposal. |
| Recurring spending | At least three distinct dates for the same description and amount, at weekly or monthly intervals. Existing schedules suppress a matching suggestion. |
| Budget | Average spending in the three most recent completed months with recorded expense activity, when there is no budget. The preview states its currency, amount and source months. A single, ledger-wide monthly budget also produces a review when recorded spending exceeds the person's own limit. |
| Spending report | At least two completed months with recorded expense history. An increase of 50% or more above the median of the preceding three recorded months raises its priority and shows both amounts. |
| Cash forecast | A known cash starting point and enough dated movements for the existing forecast. A projected negative balance receives a higher priority and displays its date. |

The default display has one action. AI Insight shows up to three and accepts supported local-language topic, explanation, open and defer requests. Review opens the existing domain editor. An accepted task is checked again against current facts. Verified changes complete it. Conditions that disappear without sufficient completion evidence invalidate it. Fresh work can become eligible again. A week-long deferral expires automatically. Dismissal persists. Reading a report or forecast after acceptance starts a seven-day cooldown.

Settings controls in-app prompts, account organization and planning. Financial edits always require review. The optional provider-backed insight and categorization paths retain their consent checks. Financial records, OCR text and account names are excluded from the assistant preferences API. The bearer-authenticated endpoint accepts only named preferences and generic dismissal or deferral choices. The offline outbox compares previous values on upload. Account-specific feedback, accepted tasks and completion evidence belong to the book that produced them.

## Boundaries and follow-up

Recognition uses a bounded multilingual vocabulary and a regional institution shortlist. An unfamiliar institution can be typed in review. A screenshot containing several accounts may require cropping. The application currently handles each assisted batch in one book currency. There is no automatic exchange-rate conversion. A person can also review an unidentified statement through the existing statement assignment workflow.

Discovery targets recurring payment and transfer evidence naming a recognized institution. Unnamed wallet counterparties, arbitrary loan descriptions and financial goals without a corresponding structured setting require further evidence and product work. Recommendation explanations use rules, recorded activity and existing analytics. Open-ended provider chat remains a separately consented website feature. There is no background delivery of recommendations outside the application.

The empty `institutionReaders` registry defines a read-only boundary for provider account observations and normalized statements. A future adapter needs an authorized provider, scoped consent, credential storage, revocation, stable external identifiers and provider-specific duplicate/replay tests. Future implementation should expand institution and language fixtures using consented or synthetic samples, then validate packaged desktop and mobile builds on supported devices before release.

## Validation on the isolated Dev branch

The broad Rails finance service and integration run passed 491 tests and 4,313 assertions. It used a newly created local PostgreSQL test database. Test mailer assets were built in the isolated checkout. Rails eager loading passed. A separate headless Rails browser run exercised editing, confirming, auditing and dismissing suggestions. After the budget and spending-trend changes, a focused Rails run passed 10 tests with 82 assertions. The final finance safety suite passed four tests with 22 assertions, including an independent check of the budget evidence.

The broad Universal run excluding the separate Apple Vision executable suite passed 1,304 tests with 13 skips. Focused checks covered all six interface languages, safe balance signs and dates, preference sync and retry, previous SQLite versions, undo replay and keyboard focus. The final focused Universal run passed 47 tests across six files. The TypeScript check and Vite production build passed. Applying all twelve migrations to an in-memory native SQLite database passed the integrity and foreign key checks.

Headless Chromium used a fresh SQLite browser context and synthetic financial records, with external requests intercepted. The scenario covered first-account navigation, actual local OCR of a generated card screenshot, differentiation of current balance from credit limit, editing and removing proposals, confirmation, dismissal, reload and a 390-pixel-wide preview.

The separate native Apple Vision test executable timed out on this Mac in the full run and on an isolated offline retry. The bundled Tesseract screenshot flow passed end to end. Native Vision accuracy on this host and packaged Windows, macOS, iOS and Android acceptance remain unverified. The checks used synthetic fixtures and local services. No live institution or external AI provider was exercised.
