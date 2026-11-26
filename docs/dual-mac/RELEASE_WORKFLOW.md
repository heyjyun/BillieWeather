# Release workflow

Two separate pipelines start from `main`:

1. **Desktop app**: development → automated tests → native QA → release build → verified DMG →
   MacBook installation. Everything up to the DMG happens on the Mac mini.
2. **Hosted web service (Render + Neon)**: deployed by Render from `main`. Its behavior is described
   separately below because it is **not** controlled by the Git workflow.

## Desktop app

| Stage | Command (Mac mini) | Gate |
| --- | --- | --- |
| 1. Develop | on `main` or a temporary branch merged into `main` after review ([GIT_SYNC.md](GIT_SYNC.md)) | commits only, reviewed; fetch and divergence check before any push |
| 2. Automated tests | `ops/doctor.sh --tests` | Rails, vitest, typecheck, cargo test, identity-api pytest, all on the isolated cluster |
| 3. Native QA | `node scripts/qa.mjs build <suffix>` + acceptance scripts (upgrade from the previous release's schema, undo/redo, failed migration, rollback) | evidence in `docs/audits/evidence/<date>-<phase>/`, report in `docs/audits/` |
| 4. Version | bump `src-tauri/Cargo.toml` + `tauri.conf.json`; write `docs/releases/<version>.md`; commit on `main`; `git tag -a v<version>` | versions agree with the tag |
| 5. Release build | `BILLIE_API_URL=… BILLIE_IDENTITY_URL=… ops/release-build.sh` | clean tree at a tag, tests pass, **two clean builds give the same executable**, identifier `com.billieweather.client` |
| 6. Verified DMG | (same script) `scripts/package.mjs` | manifest with signature facts and distribution blockers; `SHA256SUMS`; `compat.json` with database schema |
| 7. Install | MacBook: `install-stable.sh --check`, then install | see MACBOOK_STABLE.md |

Tags are pushed explicitly (`git push origin v<version>`), never implicitly.

### Release folder

```
~/BillieWeather-Releases/0.9.0-beta.1/
  BillieWeather-0.9.0-beta.1.dmg
  manifest.json      identifier, version, build, dmg/executable SHA-256, cdhash, signing authority, blockers
  compat.json        databaseSchema, upgradesFromSchemaAtLeast, sourceRevision, server URLs
  RELEASE_NOTES.md   from docs/releases/<version>.md
  SHA256SUMS         over the four files above
```

A version is built once: the script refuses an existing folder. Keep old release folders; they are the
rollback source for the app bundle (the installer also keeps a copy of the replaced app).

### Database compatibility (app SQLite)

- The app's SQLite migrations are `src-tauri/migrations/NNNN_*.sql`; the highest number is the schema
  written to `compat.json` (0.9.0-beta.1 → 10).
- Migrations are forward-only and additive. The app copies the database before migrating, and an older
  app refuses a newer schema without changing it.
- The installer refuses to install a release whose schema is lower than the database's.
- Native QA for every schema change: upgrade a synthetic book from the previous release, compare every row
  of every table, force a failing migration, roll back with the automatic copy, and go forward again.

### Signing

Personal builds are ad hoc signed, hardened, not notarized (`manifest.json` lists the blockers;
`package.mjs` exits 2). For a distributable build: 👤 a paid Apple Developer ID on the mini,
`BILLIE_SIGN_IDENTITY` and `BILLIE_NOTARY_PROFILE` (`xcrun notarytool store-credentials`).

## Render deployment (separate from Git sync)

### Actual behavior, verified 2026-11-25 from GitHub's deployment records

- The Render web service `web` has Auto-Deploy **On Commit** for `main` (GitHub environment
  `main - web`). **Every push to `origin/main` starts a production deploy.** There is no staging
  service and no separate deploy branch. The identity API has no Render service yet.
- Recent deploys:

  | Commit | Deploy result (GitHub status) |
  | --- | --- |
  | e4380af (2026-11-23) | success — last successful production deploy |
  | 63958b0 (2026-11-26 04:36Z and 04:38Z) | failure (twice) |
  | 899241e (2026-11-26 04:54Z, current `main`) | failure |

- A failed deploy leaves the previous successful deploy running (per the runbook, `/up` on e4380af
  stayed 200 after the 63958b0 failures). So production is still **e4380af**, not `main`.
- The failures are the intended fail-closed startup checks: since e4380af the build no longer migrates,
  and `bin/render-start.sh` runs `billie:release:check` before Puma, which refuses any database that is
  not the approved Neon target. The Render/Neon settings in the runbook have not been applied yet.

### Consequences for Git synchronization

- **Pushing `main` is not deployment-safe.** Right now each push is a failed deploy attempt (harmless to
  data, noisy). Once the Render settings and Neon target are fixed, every push to `main` will go to
  production immediately, without a separate approval.
- Until the owner decides, before every push to `main`: check that the commit set is acceptable as a
  production release, or have the owner first switch Render Auto-Deploy to **Off** (manual deploys) or
  to **After CI checks pass**. That change is made in the Render dashboard by the owner, not by an agent.
- Feature branches can be pushed freely: Render deploys only `main`.
- Git-sync tooling never deploys, never calls Render, and never handles production credentials.

### Production database safeguards (unchanged; never relax to get a deploy through)

- The build (`bin/render-build.sh`) never touches a database: it unsets every database variable and
  compiles assets against an unreachable dummy URL.
- The start (`bin/render-start.sh`) runs the verify-only `billie:release:check` first. It refuses to boot
  unless `BILLIE_DB_ENV`/`BILLIE_DB_NAME`/`BILLIE_DB_HOST`/`BILLIE_DB_TARGET_ID` match the read-only
  `billie_release.target` marker, the URL uses `sslmode=verify-full`, and the runtime role has no
  schema or marker write privileges. It names each failed condition and never prints a value.
- Migrations are never run by the build or start. They run only through `bin/billie-release rails`
  / `bin/billie-release identity` from a trusted Mac at the exact commit, with
  `BILLIE_RELEASE_APPROVAL`, a Neon restore point first, and the owner credential withdrawn afterwards.
- Pending additive migrations before the next deploy can start: `20261123000100`, `20261124000100`,
  `20261125000100` (`user_sessions`).
- Rollback: redeploy the last release that reads the current schema; `rollback/session-safe` is the
  documented fallback after the rollback fence is closed. Never restore the old `SECRET_KEY_BASE`.

Full settings, the marker SQL, the approved-change and rollback procedures:
[docs/audits/render-neon-release-runbook.md](../audits/render-neon-release-runbook.md).

### Deployment blockers (owner actions; none are done by agents)

1. Decide Render Auto-Deploy for `main` (keep On Commit, switch to Off, or After CI checks pass).
2. Neon, as the owner on the direct endpoint: confirm the PostgreSQL major version, create the runtime
   role, create the `billie_release.target` marker.
3. Apply the three pending migrations through `bin/billie-release rails` with approval and a restore point.
4. Set the Render environment (`BILLIE_DB_*`, verify-full runtime `DATABASE_URL`,
   `BILLIE_SECRET_KEY_BASE`) and remove the forbidden variables listed in the runbook.
5. Manual deploy, `/up` and a synthetic sign-in, then close the rollback fence (delete `SECRET_KEY_BASE`).
