# MacBook: stable installation, upgrade and rollback

The MacBook runs `/Applications/BillieWeather.app` (`com.billieweather.client`) and nothing from
development. No Homebrew, Ruby, Node or Rust is needed to install or use releases.

## What is preserved

| Item | Where | How it survives an upgrade |
| --- | --- | --- |
| Financial database | `~/Library/Application Support/com.billieweather.client/billieweather.db` | not touched by the installer; migrated by the app after its own `.pre-v<N>` copy; full copy in `~/BillieWeather-Backups/` |
| Preferences, modules, theme, classification rules, categories, relationships | same database (`settings`, `merchant_rules`, `custom_categories`, foreign keys) | same as above; Phase 6.3 checked every row of 17 tables is identical after 9→10 |
| Sign-in | Keychain item `com.billieweather.client` | identifier unchanged, so the session stays (Phase 6.3: "still signed in" after upgrade) |
| Device identity | `device-identity.json` in the data folder | copied with the folder |
| Older backups | `~/BillieWeather-Backups/`, `billieweather.db.pre-v*.bak` | never deleted by the installer |

## Install or upgrade

1. Copy the release folder from the Mac mini (`~/BillieWeather-Releases/<version>/`) with
   `scp`/`rsync` over Tailscale, or a USB drive. (AirDrop or a browser download adds a quarantine flag;
   then macOS asks for confirmation on first open because personal builds are not notarized.)
2. Copy `ops/install-stable.sh` once to e.g. `~/bin/` (or keep a read-only clone of the repo).
3. Quit BillieWeather (Cmd+Q).
4. Check, then install:
   ```sh
   ~/bin/install-stable.sh --check ~/BillieWeather-Releases/0.9.0-beta.1   # changes nothing
   ~/bin/install-stable.sh ~/BillieWeather-Releases/0.9.0-beta.1
   ```
   It verifies SHA-256 checksums, the DMG's identifier, version and executable hash, the code signature,
   database compatibility (no downgrade) and integrity; copies the current app and the whole data folder
   to `~/BillieWeather-Backups/<time>-<old version>/`; then replaces the app.
5. Open BillieWeather. Check: your entries count, categories, rules, budgets, theme; Settings shows the new
   version.

## Roll back

```sh
~/bin/install-stable.sh --status                 # version, schema, backups
~/bin/install-stable.sh --rollback               # newest pre-install backup
~/bin/install-stable.sh --rollback ~/BillieWeather-Backups/<folder>
```

The current state is kept first (`…-replaced-by-rollback`), so a rollback can itself be undone.
Rollback restores the database copy taken before the upgrade: edits made in the new version after the
upgrade are not in it (they remain in the `…-replaced-by-rollback` copy). An older app cannot open a
database a newer one has migrated; it shows an explanation and changes nothing (Phase 6.3 acceptance).

## Do not

- Install QA builds (`BillieWeather QA …`) here; the installer refuses them.
- Replace the installed 0.1.0 before 0.9.0-beta.1 passes acceptance and the "Stable servers" decision
  in ARCHITECTURE.md is made — the candidate signs in through `localhost:3000/8100` like 0.1.0.
