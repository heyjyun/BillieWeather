# BillieWeather for macOS: build, install, upgrade, roll back

## Build and package

- Release: `BILLIE_API_URL=… BILLIE_IDENTITY_URL=… npm run desktop:build`, then `BILLIE_SIGN_IDENTITY="Developer ID Application: …" BILLIE_NOTARY_PROFILE=… node scripts/package.mjs <app> <folder>`.
- QA: `node scripts/qa.mjs build`, then the same packaging script.
- The manifest next to the DMG records identifier, version, checksums, CDHash, entitlements and every open gate. Exit code 2 means blocked. An ad hoc signature is never accepted as a release.
- No entitlements are used. Reading files the person picks and talking to the servers need none outside the sandbox.

## Install

Open the DMG and drag the app to Applications. Apple Silicon, macOS 11 or later (only 27.2 was tested).

## Upgrade

Quit the app, replace it, open it. Before a schema change every database is copied next to itself (`.pre-v…bak`, the newest two are kept). If that copy fails, the app says so and stops without opening anything. Because of the new sign-in, expect to sign in once; data is kept.

## Roll back

- Quit, put the previous app back, open it. This works while the schema is the same (5.7, 5.8 and 5.9 all use 9).
- After a schema change the previous app refuses the newer file. Use Data › automatic copies to open the copy as a new database; later entries are not in it.
- Never copy database files while the app runs.
