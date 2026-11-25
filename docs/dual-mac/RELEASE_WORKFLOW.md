# Release workflow

Development → automated tests → native QA → release build → verified DMG → MacBook installation.
Everything up to the DMG happens on the Mac mini.

| Stage | Command (Mac mini) | Gate |
| --- | --- | --- |
| 1. Develop | feature branch → `autonomous-development` | commits only, reviewed |
| 2. Automated tests | `ops/doctor.sh --tests` | Rails, vitest, typecheck, cargo test, identity-api pytest, all on the isolated cluster |
| 3. Native QA | `node scripts/qa.mjs build <suffix>` + acceptance scripts (upgrade from the previous release's schema, undo/redo, failed migration, rollback) | evidence in `docs/audits/evidence/<date>-<phase>/`, report in `docs/audits/` |
| 4. Version | bump `src-tauri/Cargo.toml` + `tauri.conf.json`; write `docs/releases/<version>.md`; fast-forward `main`; `git tag -a v<version>` | versions agree with the tag |
| 5. Release build | `BILLIE_API_URL=… BILLIE_IDENTITY_URL=… ops/release-build.sh` | clean tree at a tag, tests pass, **two clean builds give the same executable**, identifier `com.billieweather.client` |
| 6. Verified DMG | (same script) `scripts/package.mjs` | manifest with signature facts and distribution blockers; `SHA256SUMS`; `compat.json` with database schema |
| 7. Install | MacBook: `install-stable.sh --check`, then install | see MACBOOK_STABLE.md |

## Release folder

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

## Database compatibility

- The app's SQLite migrations are `src-tauri/migrations/NNNN_*.sql`; the highest number is the schema
  written to `compat.json` (0.9.0-beta.1 → 10).
- Migrations are forward-only and additive. The app copies the database before migrating, and an older
  app refuses a newer schema without changing it.
- The installer refuses to install a release whose schema is lower than the database's.
- Native QA for every schema change: upgrade a synthetic book from the previous release, compare every row
  of every table, force a failing migration, roll back with the automatic copy, and go forward again.

## Signing

Personal builds are ad hoc signed, hardened, not notarized (`manifest.json` lists the blockers;
`package.mjs` exits 2). For a distributable build: 👤 a paid Apple Developer ID on the mini,
`BILLIE_SIGN_IDENTITY` and `BILLIE_NOTARY_PROFILE` (`xcrun notarytool store-credentials`).
