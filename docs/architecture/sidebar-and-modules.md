# Modules, the sidebar and Settings

Status: implemented 2026-11-28 (catalog version 3). Applies to the website (Rails) and the universal
app (macOS, Windows, iOS, Android, browser preview).

## Four separate questions

| Question | Who decides | Stored | Code |
| --- | --- | --- | --- |
| **Availability**: is the module built on this surface? | the catalog | no | `availability` in `packages/shared-types/schema/module-catalog.json` |
| **Functionality**: can it be used? | derived: every available module, for every account | no | `isModuleEnabled` / `ModuleCatalog.enabled?` |
| **Sidebar visibility**: does it have a sidebar entry? | the person; else `default_sidebar_visible` | per module | `ModulePreference`, `ModulePreferences.modules` |
| **Sidebar order**: in which order are the entries? | the person; else catalog `order` | one list per account | `SidebarOrder`, `ModulePreferences.order` |

Hiding a module, or moving it, never disables it, never deletes or changes data, never stops
processing (recurring entries still post, receipts still match), and never hides it from AI
workflows: commands and assistants check availability, not the sidebar. Every hidden module stays
reachable from Settings (its section, and the Feature Library) and by direct link.

**Settings** is a system entry, not a module: always shown, always last, never stored, never movable.
It is one control centre for the whole app; it is not split by Manual or AI-automatic mode.

## The catalog is the single source

`packages/shared-types/schema/module-catalog.json` lists every module with its availability per
surface, `default_sidebar_visible` and `order`. The website reads it in
`app/models/finance/module_catalog.rb`; the apps in `packages/shared-types/src/modules.ts`. No client
keeps its own list. Both resolve preferences with the same rules and replay the same cases
(`packages/shared-types/fixtures/module-preference-cases.json`, from `test/models/finance/module_catalog_test.rb`
and `clients/universal/test/modules.test.ts`).

Default sidebar since catalog version 3: **Transactions, AI Insight, Financial Overview, Categories
(& Tags), Accounts & Assets**, then Settings. The order comes from the catalog `order` values
(10, 20, 21, 22, 40), so no separate default list exists.

### Existing accounts

Only explicit choices are stored. An account that never chose sees the new defaults; an explicit
choice (shown or hidden) is kept exactly, from either catalog version, under the current key
`sidebarVisible` or the legacy `enabled`.

## Resolving the sidebar

```
entries = available modules that are shown (explicit choice, else default)
sidebar = entries named in the saved order, in that order, each once
        + the other entries, in catalog order
        + Settings
```

`orderSidebar` (TypeScript) and `ModuleCatalog.order_sidebar` (Ruby) implement this. Ids the saved
order names but that are hidden, unknown, unavailable here or duplicated add nothing, so the result
is deterministic and never has duplicates. A module added to the catalog later, or shown after the
order was saved, appears after the arranged entries and never moves them.

The server keeps a saved entry in its previous slot when another surface cannot display it. For
example, reordering in the app preserves the website-only Forecast entry. Restore defaults resets
visibility and order for the modules supported by the surface that issued it. Shared modules reflect
that reset on every surface where they are supported.

## Storage and synchronization

- **Website**: `finance_module_preferences` (one row per explicit visibility choice, revisioned) and
  `finance_sidebar_orders` (one row per account: `module_keys` JSON array, `revision`, `changed_at`,
  `updated_by_device_id`; migration `20261128000100`). No row means catalog order. Restore defaults
  rewrites changed visibility rows and clears the order for the modules it resets. The website saves
  through Rails while connected.
- **Apps**: `localStorage` per account (`billie.modules.v1:<owner>`, `ModulePreferences` with
  optional `order`) for offline use and restarts, plus the sync replica (`billie.modules.v2:<account>`,
  `services/moduleSync.ts`) with the last account snapshot and queued writes.
- **Sync API** (`/api/client/v1/module_preferences`, format 2): the snapshot reports
  `sidebar_order` (`null` until saved); a mutation may carry `sidebar_order: {module_keys,
  expected_revision}` with zero or more visibility changes. The order revision is part of
  `server_revision`. A stale `expected_revision` returns `order_applied: false` and `order_conflict`
  with the current order: **the account's order wins**, the device drops its attempt (it never forces
  a write). First contact: the account's order wins; if the account has none, the device's order is
  uploaded.
- **Compatibility**: apps released before this change never send an order and ignore the new field.
  An app connected to a server without order support keeps the order locally. When support becomes
  available, the app synchronizes using the first-contact rule. Saved replicas without `orderPending`
  still load.

## Settings › Sidebar customization

Same section on both surfaces (`app/views/finance/feature_library/_sidebar_customization.html.erb`,
`clients/universal/src/settings/SidebarCustomization.tsx`), registered first in the "features" area
(`Finance::SettingsSections`, `settings/registry.tsx`):

- the entries in order, each with a drag handle and Move up / Move down buttons (the buttons work
  without JavaScript on the website and from the keyboard in the app), and Hide;
- Settings, fixed last, without controls;
- "Add to the sidebar" for every other available module;
- Restore defaults (visibility and order). The Feature Library embedded in Settings no longer has its
  own Restore button, so the page has one.

Changes show in the sidebar immediately (the website returns the new sidebar HTML; the app re-renders
from the same state). During a drag, both surfaces mark the destination and keep the list in place
until the drop. On the app, the file-drop guard lets sidebar drags reach the reorder handler and
still guards file drops from outside the app.

## Tests

- Shared cases: `module-preference-cases.json` (defaults, order, legacy keys, unknown/duplicate ids,
  unsupported modules, choices made before version 3).
- Website: `test/models/finance/sidebar_order_test.rb` (including preservation of existing visibility
  choices through the migration), `module_catalog_test.rb`,
  `test/integration/finance_feature_library_test.rb` (section, arrows without JavaScript, JSON drag,
  conflicts, refusal, add/hide/restore), `client_api_module_preferences_test.rb` (order sync,
  platform-specific entries, conflicts, retries, invalid lists, older apps).
- App: `clients/universal/test/sidebarOrder.test.tsx` (defaults, arrows, drag, add/hide/restore,
  restart, legacy preferences, replica queue/freeze/acknowledge/conflict/first sync/old server,
  synchronization between two devices), `modules.test.ts`, `featureLibrary.test.tsx`, and
  `dropGuard.test.ts`.
