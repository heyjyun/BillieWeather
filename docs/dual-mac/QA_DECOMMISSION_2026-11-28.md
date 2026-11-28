# QA decommission and main-only verification, 2026-11-28

On 2026-11-28 the owner directed two things. BillieWeather keeps only two runtime environments,
**Development** (with the Dev app) and **Production** (with the Stable app), and there is no dedicated
QA environment. Development happens on `main` only. This file records what was removed, what was
kept, and why.

## Final state

| Item | State |
| --- | --- |
| Local branches | `main` only |
| Remote branches | `origin/main` only (no tags on GitHub) |
| Worktrees / checkouts | one: the primary checkout. A stray clone in `/private/tmp` was backed up and removed (see below) |
| Runtime environments | Development: working tree of `main`, Neon branch `development`, Dev app `com.billieweather.client.dev`. Production: Render plus Neon `production`, Stable app `com.billieweather.client` |
| QA builds, QA servers, QA scripts | none |

## Removed from the repository

- `clients/universal/scripts/qa.mjs`, which built, preflighted and launched QA bundles with the
  identifiers `com.billieweather.client.qa.*`, and its `npm run qa` script.
- The QA variant in `src-tauri/src/variant.rs`, which handled the `.qa` identifier rules and the
  isolated-port checks. The other launch guards are unchanged:
  - a debug build never runs as the shipped identifier;
  - a bundle and binary with different identifiers refuse to start;
  - the data-folder link checks still apply.
- QA handling in `scripts/package.mjs`. It now packages only the Stable identifier.
- `test/qaIsolation.test.ts`, replaced by `test/variantIsolation.test.ts`. That file keeps every
  Dev/Stable variant assertion and checks that no QA script or identifier remains.
- The QA build check in `ops/doctor.sh --build`. It now builds the Dev app into a temporary folder
  and installs nothing.
- `BILLIE_QA_*` variables in `ops/env/mac-mini.env.example` and the QA hint in `ops/dev-services.sh`.
  The isolated local cluster on ports 38530/38531 stays as a disposable development and test backend.
- QA steps in AGENTS.md, CONTRIBUTING.md, and `docs/dual-mac/*`. Historical audit reports and evidence
  under `docs/audits/`, `docs/sprints/` and `docs/qa/` are kept unchanged as records.

## Removed from the Mac where this ran (backed up first)

All backups are in `~/BillieWeather-Backups/20261128-qa-decommission/` (mode 700).

| Resource | Backup |
| --- | --- |
| 62 app-data folders and preference files of QA and old test builds (`com.billieweather.client.qa.*`, `com.billieweather.qa`, `…dropqa`, `…phase1a.qa.*`, `…roadmap.*`) in Application Support, Caches, WebKit and Preferences | `qa-app-data-library.tgz`, list in `library-items.txt` |
| QA source exports `/private/tmp/billie-qa-source.*`, `billie-release-qa.*`, `billie-registration-qa.*` | `qa-source-checkouts.tgz` (without `node_modules` and build output) |
| Stray clone `/private/tmp/billie-dev-sidebar.oDVfUica/source`. Its `main` held 1c7dda7 and eddf45f, which are not ancestors of `main`. A trial merge showed `main` already contains all of that work: 64 of its 82 changed files are identical in `main`, and its migration `20261128000200` is in `main`. The remaining conflicts were the pre-overview UI that `main` replaced | `stray-clone-billie-dev-sidebar.bundle` (verified) |
| QA `.app` bundles in build output (`src-tauri/target/debug/bundle`, `/private/tmp/billie-*/…/bundle`) | not needed: rebuildable output |

The data of the Stable app (`com.billieweather.client`) and the Dev app (`com.billieweather.client.dev`)
was not touched.

## Kept on purpose, for the owner to decide

- **Neon branches.** The project has six branches. `production` and `development` are the two
  environments. `release-predeployment-20261125` is a pre-deploy snapshot of production and is kept as
  a recovery point. Three more are copies of production data, so they were not deleted:
  - `migrate-test-nickname`, created 2026-11-09. It predates the deletion of the original owner account
    on 2026-11-23, so it may hold the only copy of that account's records.
  - `release-migration-rehearsal-20261125`.
  - `release-rehearsal-20261126`, kept until the G2–G4 release acceptance
    (STABLE_PRODUCTION_PLAN_2026-11-26.md).

  To remove one of them, dump it first (`pg_dump -Fc`), then run
  `neon branches delete <id> --project-id sparkling-sun-34139417`.
- **Keychain items of old QA and test builds.** These are sign-in tokens for synthetic servers:
  `com.billieweather.client.qa.p63`, `…qa.settings`, `…qa.settingsref`, `com.billieweather.qa.dev`,
  `com.billieweather.roadmap.phase3.dev`, `…phase5`, `…phase5.dev`, `…phase52`. Deleting them from a
  session can bring up a macOS authorization prompt, so they are left for the owner. Delete each with
  `security delete-generic-password -s <service>`.
- **Archived QA bundles and DMGs** in `../ClaudeGenerated/` and `../ReleaseVerification/`. These are
  historical release evidence, not active versions.
- **Orphaned temporary PostgreSQL clusters** in `/private/tmp/billie-roadmap.Zep2ONRZ`,
  `/private/tmp/billie-roadmap.weIphlqR` and `/tmp/billie-overview.cEm5Xi`. They hold synthetic data and
  have no client connections. The session was not permitted to stop them. Stop each with
  `pg_ctl -D <dir>/data stop -m fast` (for the overview cluster, `<dir>/db`) and then delete the folders.
- **Render.** `render.yaml` defines no QA service. There is no Render API access from this Mac, so the
  dashboard was not inspected.
