# Render and Neon database release runbook

## Why the 63958b0 deploy failed, and the exact settings that make it start (2026-11-25)

Up to e4380af the build ran `db:migrate` (`RUN_MIGRATIONS=1`) with whatever `DATABASE_URL` the service had,
and the start command was plain Puma. Since then the build never touches a database, the start command
runs `billie:release:check` first, and `config/database.yml` refuses any production URL that is not the
approved target. Render rolled back to e4380af automatically (both 63958b0 deploys: `failure`; `/up`
on e4380af stayed 200). Without dashboard logs the exact line is unconfirmed, but a service that was not
re-provisioned fails at the first of these, in this order. Since this commit the refusal names every
failed condition (never a value), so the deploy log says which one:

1. Dashboard still on the old commands, or `BILLIE_DB_*` unset → `PostgreSQL URL does not match the approved database target: BILLIE_DB_ENV must be …; BILLIE_DB_NAME is missing; …`
2. Neon's default URL (`sslmode=require`) → `…: the URL must set sslmode=verify-full`
3. `verify-full` without a trust root → libpq `root certificate file "…/.postgresql/root.crt" does not exist`
4. No `billie_release.target` marker → `relation "billie_release.target" does not exist`
5. Runtime URL uses the owner role (e.g. `neondb_owner`) → `Runtime database role has schema or target-marker write privileges`
6. Migrations not applied → `ActiveRecord::PendingMigrationError` (`20261123000100`, `20261124000100`, `20261125000100`; all additive)
7. `BILLIE_SECRET_KEY_BASE` missing and no `SECRET_KEY_BASE` → `Unsafe production settings: BILLIE_SECRET_KEY_BASE is missing`

None of these checks may be relaxed to get a deploy through; fix the settings instead.

### Render web service (`web`, Ruby) — Settings

| Setting | Value |
| --- | --- |
| Build Command | `./bin/render-build.sh` |
| Start Command | `./bin/render-start.sh` |
| Health Check Path | `/up` |
| Auto-Deploy | **Off** — deploys are started by hand (Manual Deploy → a commit of `main`); `render.yaml` sets `autoDeployTrigger: "off"` as a backstop |

If the service was created by hand rather than from the Blueprint, Render ignores `render.yaml`: set the
commands above in the dashboard.

### Render web service — Environment (names only; values from the Neon console / generated)

| Variable | Value |
| --- | --- |
| `RAILS_ENV` | `production` |
| `DATABASE_URL` | `postgresql://<runtime_role>@<ep-id>-pooler.<region>.aws.neon.tech/<db>?sslmode=verify-full&sslrootcert=/etc/ssl/certs/ca-certificates.crt`, with the role's password after the role name, as in Neon's copy button (the CA bundle path is Ubuntu's, as on Render's native runtime; `sslrootcert=system` is the alternative. `channel_binding=require` and `connect_timeout` may be added; any other option, e.g. `options=`, is refused) |
| `BILLIE_DB_ENV` | `production` |
| `BILLIE_DB_HOST` | `<ep-id>.<region>.aws.neon.tech` (direct host, without `-pooler`) |
| `BILLIE_DB_NAME` | `<db>` (same as in the URL) |
| `BILLIE_DB_TARGET_ID` | the identifier stored in `billie_release.target` (12–128 of `A-Z a-z 0-9 _ -`; not a secret) |
| `BILLIE_SECRET_KEY_BASE` | at least 64 characters (`openssl rand -hex 64`). An environment group created before this release does **not** get it from `generateValue`; add it by hand |
| `REDIS_URL` | from the Key Value service (optional; without it a warning only) |
| `BILLIE_MODULE_SYNC` | `1` to serve `/api/client/v1/module_preferences` (feature-library sync). Unset, that route answers 404 and the apps keep their choices on the device only |
| `WEB_CONCURRENCY` / `RAILS_MAX_THREADS` | `0` / `3` |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, `POSTMARK_API_TOKEN` + `MAIL_FROM` | optional, but each pair complete or absent |
| `BASE_URL` | optional `https://…`; Render's `RENDER_EXTERNAL_URL` is used otherwise |

Must **not** be set on the service: `SECRET_KEY_BASE_DUMMY`, `BILLIE_ASSET_BUILD`, `PGSERVICE`,
`PGSERVICEFILE`, `PGHOSTADDR`, `PGOPTIONS`, `DATABASE_URL_UNPOOLED` and any owner/DDL URL, `RUN_MIGRATIONS`
(now ignored; remove). `SECRET_KEY_BASE` may stay for the first deploy (warning only); delete it after the
smoke test ("Close the rollback fence" below).

### Neon (once, as the owner, on the direct endpoint) — then deploy

1. Confirm the PostgreSQL major version in the Neon console (CI and local development use 18).
2. Create a runtime role (e.g. `billie_rails_runtime`) with `LOGIN` only, no `CREATEDB/CREATEROLE`; grant
   `USAGE` on schema `public`, `SELECT, INSERT, UPDATE, DELETE` on its tables and `USAGE, SELECT` on its
   sequences (plus `ALTER DEFAULT PRIVILEGES` for future tables), and make sure `PUBLIC` has no `CREATE`
   on the database or `public` schema.
3. Create the `billie_release.target` marker (SQL below) with `target_environment=production`.
4. From a trusted Mac with a checkout of the exact commit: inject `DATABASE_URL_UNPOOLED` (owner, direct
   host, `verify-full`), `BILLIE_RELEASE_APPROVAL`, and the four `BILLIE_DB_*`; run `bin/billie-release rails`.
   Take a Neon branch/restore point first. Withdraw the owner credential afterwards.
5. Set the Render settings above, then *Manual Deploy → Deploy latest commit*. Check `/up` and a synthetic
   sign-in.

The identity API has no Render service yet (GitHub shows only the `main - web` environment). When it is
created from `services/identity-api/render.yaml`, it needs the same four `BILLIE_DB_*`, its own runtime
role on the same database, and `bin/billie-release identity` once.

## Prepare the target

1. Verify the Neon project, branch ID, database name, direct endpoint, and pooled endpoint in the control plane. Both Render services must use the same approved branch and database. Use an approved branch with synthetic data for staging.
2. Have the database owner provision the read-only `billie_release.target` marker using the SQL below. Give each branch its own non-secret identifier after a copy.
3. Set each service's `DATABASE_URL` to the pooled URL for its dedicated runtime role. Set `BILLIE_DB_ENV`, `BILLIE_DB_HOST` (the direct hostname), `BILLIE_DB_NAME`, and `BILLIE_DB_TARGET_ID`. Remote URLs require `sslmode=verify-full` and a usable trust root. Check the effective environment groups and commands in Render for both services. The startup checks compare the database, role, environment, and identifier returned by PostgreSQL.
4. Manage schema ownership and release credentials separately from runtime credentials. Grant each runtime role only its required DML, sequence, and schema usage privileges. Review grants to `PUBLIC`, object and schema ownership, members of privileged roles, and default grants on future objects. Rails needs to read its migration history. Identity needs access to its own data and migration history, plus the Rails account tables and sequences it uses.
5. Verify the effective Auto-Deploy and Blueprint sync settings for both services. Complete the approved migration and startup configuration before pushing to any branch that triggers a production deploy. Remove any stored DDL credentials and old migration variables from the service environments. Remove production URLs from existing development configurations and verify those services use local databases after restart. Use `bin/billie-local` for isolated development. For the development container, run `./bin/rails db:prepare` explicitly against the configured local database before starting `./bin/dev`. The `local` release label is for a local PostgreSQL rehearsal and is rejected on Render.

Run as the owner on the verified direct endpoint. Supply the psql variables `target_id`, `target_environment`, `rails_runtime`, and `identity_runtime`. On a cloned branch with an existing marker, update its single row as the owner before allowing either service to connect.

```sql
BEGIN;
CREATE SCHEMA billie_release;
REVOKE ALL ON SCHEMA billie_release FROM PUBLIC;
CREATE TABLE billie_release.target (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('local', 'staging', 'production')),
  target_id text NOT NULL CHECK (target_id ~ '^[a-zA-Z0-9_-]{12,128}$')
);
INSERT INTO billie_release.target (environment, target_id)
VALUES (:'target_environment', :'target_id');
REVOKE ALL ON billie_release.target FROM PUBLIC;
GRANT USAGE ON SCHEMA billie_release TO :"rails_runtime", :"identity_runtime";
GRANT SELECT ON billie_release.target TO :"rails_runtime", :"identity_runtime";
COMMIT;
```

### Provision the marker and runtime roles separately

Connect to the verified direct endpoint using a release-only owner credential. Pass
`target_database`, `target_owner`, `target_environment`, and `target_id` as psql variables
to `ops/neon-release-provision.sql`.

1. Before the very first G2, the target has no marker. Use `ops/infrastructure.py backup
   --before-marker` with a recoverable GPG recipient. It checks the exact Production host,
   owner, database and PostgreSQL read-only setting before starting the dump.
2. Run the provisioning script with `phase=marker`, then the separately approved
   `bin/billie-release rails` and `bin/billie-release identity` migrations.
3. Run the same script with `phase=roles`. Inject separate randomly generated values into
   `BILLIE_RAILS_RUNTIME_PASSWORD` and `BILLIE_IDENTITY_RUNTIME_PASSWORD` through the operator
   process. Existing runtime roles make this step fail, so credentials are never changed as a
   side effect of resuming a release. Verify both logins and grants before updating Render.

## Apply an approved database change

1. Record the exact Git commit, approved target, change reference, and database and application owners. Review compatibility with the currently running code and decide whether the writes involved in the change must be paused.
2. Record the recovery point and confirm the actual Neon retention window. Use an approved direct connection to create an encrypted backup, record its checksum, and rehearse restoring it in an approved isolated target. Verify both migration histories, critical constraints and indexes, account ownership, and transaction amounts.
3. In a controlled release environment for the pinned commit, inject `DATABASE_URL_UNPOOLED`, `BILLIE_RELEASE_APPROVAL`, and the four verified `BILLIE_DB_*` settings. Run `bin/billie-release rails` and then `bin/billie-release identity`. Rails advances its existing migration history. Identity checks Rails compatibility and applies its own pending migrations in one transaction. Verify schema versions and data constraints, then withdraw the migration credentials. Migration `20261125000100` (`user_sessions`) is additive and must be applied before the Rails release that uses it; without the table every sign-in fails closed. Grant the Rails runtime role DML on the table and its sequence. Everyone signs in once after that release.
4. Start Rails and identity-api with their restricted runtime roles. Check `/up`, `/health`, Redis, and the approved synthetic-account smoke flow for signup, login, and ledger access. Approve production rollout separately. Review and apply any seed changes as an independent operation.

## Close the rollback fence (once, with the first release that has `user_sessions`)

Releases before server-side sign-ins accept signed tokens that cannot be revoked one by one, and read their signing key from `SECRET_KEY_BASE`. This release reads `BILLIE_SECRET_KEY_BASE`.

1. Create `BILLIE_SECRET_KEY_BASE` with a fresh value (`openssl rand -hex 64`, or let the blueprint generate it). Everyone has to sign in once anyway; outstanding password-reset links and unfinished command plans stop working too.
2. Deploy, run the smoke test, then delete `SECRET_KEY_BASE` from the service **and** the environment group. The start-up check warns while it still holds the same value.
3. From then on a rollback to an older release either refuses to boot (key missing) or accepts no earlier credential (another value). Rehearsed: [evidence](evidence/2026-11-25-overnight/rollback-rehearsal.txt).
4. If the application must be rolled back, deploy commit `dbd85e7` (formerly the branch `rollback/session-safe`; it is in `main`'s history through a content-free merge): the previous release plus server-side sign-ins, on the current schema. It keeps revoked sign-ins revoked. Never put the old `SECRET_KEY_BASE` value back. `dbd85e7` has no `bin/render-start.sh` and no module-preference routes: set the Start Command to `bundle exec puma -C config/puma.rb` for that deploy and back to `./bin/render-start.sh` when rolling forward (rehearsed 2026-11-26).

## Roll back

- Consider disabling `BILLIE_MODULE_SYNC` or pausing affected writes. Preserve transactions, imports, transfer and refund links, preference replay records, and audit data.
- Prefer redeploying the last application version that can read and write the current schema. A Render Dashboard rollback can reuse the old start command and environment variables. If an old artifact has an implicit schema or seed step, rebuild the prior application with the verified release startup path before deploying it. Render artifact rollback leaves PostgreSQL as it is.
- If data recovery is necessary, isolate the affected branch and backups first. On Neon, every branch created from or restored on a provisioned branch gets the runtime role re-created by Neon as a `neon_superuser` member, which the owner cannot alter: delete it with `neon roles delete <role> --branch <id>` and run `ops/neon-release-provision.sql` again before any service connects (rehearsed 2026-11-26). Neon `pg_dump` output carries `SET (pg_attver=…)`; strip those lines (`pg_restore -f - … | grep -v "SET (pg_attver="`) to restore into a vanilla PostgreSQL. Account for writes after the restore point. Restore into an isolated target and reconcile missing writes, replays, and account balances before the approved cutover. Use a down migration only after review of the specific migration and its data effects.
- Confirm the app versions, service targets, both migration histories, role grants, and transaction, refund, transfer, and import invariants. Revoke temporary privileges and retain the audit evidence.

See [Render Blueprints](https://render.com/docs/blueprint-spec), [Render rollbacks](https://render.com/docs/rollbacks), [Neon connection methods](https://neon.com/docs/connect/choose-connection), and [Neon restore](https://neon.com/docs/introduction/branch-restore).
