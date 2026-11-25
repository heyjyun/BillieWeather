# Editing history: Undo and Redo

Local schema 10, all app platforms (macOS, Windows, iOS, Android share `clients/universal/src`). Decided 2026-11-25 (Phase 6.3).

## Model

- One operation of a person = one **history group**, however many transactions it needs. Groups form one line per database: undo takes the newest done group, redo the group undone last.
- A group holds **row images** (JSON, every column but `updated_at` and insert-time helpers) before and after. Primary keys never change, so an entry comes back as the same entry: same id, same uuid, same links.
- **The database records, not the operations.** The first statement of a recorded transaction opens the group in `history_state`; triggers (migration 0010) note each row at first touch; the last statements store the after images and close the group. Rows changed by other triggers (refund links, staged imports) and foreign-key actions are therefore included, and an edit and its history commit together or not at all.
- `services/history/policy.ts` lists every writing operation as recorded or as not recorded with the reason; a test fails for one that is missing.

## Guarantees of a step (one transaction)

1. Only the group that was shown on the button, and only while it is the end of the line.
2. Every row is exactly what the group left (or already what it should become). Otherwise nothing is written, the group is dropped and the person is told.
3. Nothing outside the group may hang on an entry, statement or schedule that leaves. Accounts, merchants, projects and tags that came with an entry and are used elsewhere by now stay.
4. Afterwards every row is exactly the other side; no foreign key is newly broken; no entry, rule or budget names a removed category. All existing guards (refund limits, immutable bank text, transfer legs) stay active.
5. The step is written to the append-only operation log.

A busy or unreadable database is an error, not a conflict: the group stays.

## Boundaries

| | |
| --- | --- |
| New recorded edit | ends redo |
| Edit that changes nothing, refused edit | no group, redo stays |
| Limit | 100 groups, 60,000 row images; the newest always stays |
| Restart, crash | history persists; a group is never left open |
| Other database, other account | own history, inside its own file |
| Backup, restore, snapshot | backups carry none; a restored book starts empty |
| Permanent deletion (trash, "Remove from this device", delete all, website deletion) | never recorded; a trigger deletes every group that mentions the entry |
| Website download, automatic schedule posting, sync | not recorded; what they change later is protected by rule 2 |
| Classification protection | `user_locked_fields`, `category_source`, `locally_modified` are part of the image: undoing a later edit keeps the person's choice protected; undoing the choice itself gives the row back to automation |

Not undoable on purpose: imported amounts and dates are evidence and cannot be edited at all; import templates, database name, sync preferences; merging databases.

Known limit: an operation made of several transactions (a new merchant, then the entry) is one group but not one transaction. A crash between them leaves a smaller, valid group.

## Rules for later migrations

Changing a recorded table requires rebuilding its triggers (`triggersSql`) and deleting all groups in the same migration. The coverage test enforces the first half.

## Website

The Rails ledger (PostgreSQL) keeps its own operation log, trash and undo of AI batches. It has **no** redo and no undo of single edits; nothing here changes it. The same model fits (audit images per request, same rules 1–5) but needs a production migration, so it is a separate decision.
