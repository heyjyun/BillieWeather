# Render and Neon database release runbook

## Prepare the target

1. Verify the Neon project, branch ID, database name, direct endpoint, and pooled endpoint in the control plane. Both Render services must use the same approved branch and database. Use an approved branch with synthetic data for staging.
2. Ask the database administrator to set database-level defaults for `billie.environment` and `billie.target_id`. Use `staging` or `production` for the environment and a distinct, non-secret identifier of 12–128 letters, numbers, underscores, or hyphens. Set fresh values after a branch copy so the clone has its own identity.
3. Set each service's `DATABASE_URL` to the pooled URL for its dedicated runtime role. Set `BILLIE_DB_ENV`, `BILLIE_DB_HOST` (the direct hostname), `BILLIE_DB_NAME`, and `BILLIE_DB_TARGET_ID`. Remote URLs require `sslmode=verify-full` and a usable trust root. Check the effective environment groups and commands in Render for both services. The startup checks compare the database, role, environment, and identifier returned by PostgreSQL.
4. Manage schema ownership and release credentials separately from runtime credentials. Grant each runtime role only its required DML, sequence, and schema usage privileges. Review grants to `PUBLIC`, object and schema ownership, members of privileged roles, and default grants on future objects. Rails needs to read its migration history. Identity needs access to its own data and migration history, plus the Rails account tables and sequences it uses.
5. Verify automatic deploys are off for both services. Remove any stored DDL credentials and old migration variables from the service environments. Remove production URLs from existing development configurations and verify those services use local databases after restart. Use `bin/billie-local` for isolated development. For the development container, run `./bin/rails db:prepare` explicitly against the configured local database before starting `./bin/dev`. The `local` release label is for a local PostgreSQL rehearsal and is rejected on Render.

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
4. If the application must be rolled back, deploy the local branch `rollback/session-safe`: the previous release plus server-side sign-ins, on the current schema. It keeps revoked sign-ins revoked. Never put the old `SECRET_KEY_BASE` value back.

## Roll back

- Consider disabling `BILLIE_MODULE_SYNC` or pausing affected writes. Preserve transactions, imports, transfer and refund links, preference replay records, and audit data.
- Prefer redeploying the last application version that can read and write the current schema. A Render Dashboard rollback can reuse the old start command and environment variables. If an old artifact has an implicit schema or seed step, rebuild the prior application with the verified release startup path before deploying it. Render artifact rollback leaves PostgreSQL as it is.
- If data recovery is necessary, isolate the affected branch and backups first. Account for writes after the restore point. Restore into an isolated target and reconcile missing writes, replays, and account balances before the approved cutover. Use a down migration only after review of the specific migration and its data effects.
- Confirm the app versions, service targets, both migration histories, role grants, and transaction, refund, transfer, and import invariants. Revoke temporary privileges and retain the audit evidence.

See [Render Blueprints](https://render.com/docs/blueprint-spec), [Render rollbacks](https://render.com/docs/rollbacks), [Neon connection methods](https://neon.com/docs/connect/choose-connection), and [Neon restore](https://neon.com/docs/introduction/branch-restore).
