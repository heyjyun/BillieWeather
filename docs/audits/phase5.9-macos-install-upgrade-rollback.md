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

## Versions and keychain (2026-11-25)

- Version: `clients/universal/package.json` only; Tauri reads it, Cargo.toml and the lock file are checked by `test/package.test.ts`. Build number (`CFBundleVersion`): the commit count, set by `tauri.mjs build` and `qa.mjs build`. Raise the version for every release; same version plus a higher build is for rebuilds only.
- Entitlements: none, on purpose. A library that needs one is a review item.
- Keychain: an **ad hoc** build has no stable signing identity. Opening a different ad hoc build over an existing sign-in brought up a macOS authentication prompt (2026-11-25; cause not read, keychain access is the likely one). Developer ID builds keep a stable designated requirement, so an update should not ask; confirm this on the first signed pair of builds. QA: use a new suffix (`qa.mjs build <suffix>`) or sign out before changing builds.
- One copy at a time: a second copy says so and opens nothing (`.in-use` lock in the data folder).
- Only Apple Silicon is built. Intel needs the `x86_64-apple-darwin` standard library (no rustup here) and its own acceptance.
